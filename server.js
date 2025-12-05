// --- NOUVEAUTÉS PG et DOTENV ---
// Si vous utilisez dotenv pour le développement local
require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const path = require('path');
// Changement : Utilisation de 'pg' à la place de 'sqlite3'
const { Pool } = require('pg');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Création dossier uploads
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir });

app.use(express.json());
app.use(cors());
// Assurez-vous que le chemin d'accès statique ne cause pas de conflit.
app.use(express.static(path.join(__dirname))); 

// --- 1. CONNEXION BASE DE DONNÉES (POSTGRESQL) ---
// Utilisation de Pool pour la gestion des connexions, très adapté aux serveurs
const pool = new Pool({
    // La variable DATABASE_URL sera fournie par Render, ou lue par dotenv en local
    connectionString: process.env.DATABASE_URL,
    // Configuration requise par Render si vous utilisez le SSL
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect((err, client, release) => {
    if (err) {
        console.error("❌ Erreur de connexion à PostgreSQL. Vérifiez DATABASE_URL.", err.message);
    } else {
        console.log("✅ Connecté à la base de données PostgreSQL.");
        release(); // Libère la connexion
    }
});

// Fonction utilitaire pour exécuter des requêtes avec les paramètres
const query = (text, params) => pool.query(text, params);

// --- 2. CRÉATION DES TABLES (ADAPTATION POUR POSTGRES) ---
// On utilise une approche asynchrone pour les requêtes DDL
async function createTables() {
    try {
        await query(`CREATE TABLE IF NOT EXISTS schools (id SERIAL PRIMARY KEY, name TEXT)`);
        await query(`CREATE TABLE IF NOT EXISTS students (id SERIAL PRIMARY KEY, name TEXT, code TEXT UNIQUE, school_id INTEGER)`);
        await query(`CREATE TABLE IF NOT EXISTS grades (id SERIAL PRIMARY KEY, student_id TEXT, subject TEXT, score REAL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await query(`CREATE TABLE IF NOT EXISTS absences (id SERIAL PRIMARY KEY, student_id TEXT, date TEXT, reason TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await query(`CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, type TEXT, title TEXT, message TEXT, target_id TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        
        await query(`CREATE TABLE IF NOT EXISTS access_requests (
            student_id INTEGER PRIMARY KEY, 
            device_id TEXT, 
            status TEXT DEFAULT 'PENDING',
            message TEXT, 
            request_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("✅ Tables PostgreSQL vérifiées/créées.");
    } catch (err) {
        console.error("❌ Erreur lors de la création des tables:", err);
    }
}
createTables(); // Lancer la création des tables au démarrage

// --- 3. FONCTION GÉNÉRATION CODE ---
function generateStudentCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const nums = '0123456789';
    let code = '';
    for (let i = 0; i < 2; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    code += '-';
    for (let i = 0; i < 4; i++) code += nums.charAt(Math.floor(Math.random() * nums.length));
    return code;
}

// --- 4. ROUTE IMPORT EXCEL ---
// Changement : Utilisation de transaction et de $1, $2, $3 pour les paramètres de requête
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Aucun fichier reçu.' });
    const client = await pool.connect();
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet);
        let count = 0;

        await client.query('BEGIN'); // Début de transaction
        
        for (const row of data) {
            const name = row.Nom || row.nom || row.Name || row.name || row['Nom Prénom'] || "Inconnu";
            if (name !== "Inconnu") {
                const newCode = generateStudentCode();
                // Utilisation de la syntaxe INSERT INTO ... ON CONFLICT DO NOTHING de Postgres
                const text = "INSERT INTO students (name, code, school_id) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING";
                await client.query(text, [name, newCode, 1]);
                count++;
            }
        }

        await client.query('COMMIT'); // Fin de transaction
        try { fs.unlinkSync(req.file.path); } catch(e) {}
        res.json({ message: `Succès : ${count} élèves tentés d'être ajoutés.` });
    } catch (error) { 
        await client.query('ROLLBACK'); // Annulation si erreur
        console.error("Erreur lecture Excel ou DB:", error);
        res.status(500).json({ message: "Erreur lors de l'import Excel ou DB." }); 
    } finally {
        client.release();
    }
});

// --- 5. ROUTE LOGIN ---
app.post('/api/login', async (req, res) => {
    const { code, device_id } = req.body;
    try {
        // Changement : Utilisation de query() et de $1 pour les paramètres
        let studentResult = await query("SELECT id, name FROM students WHERE code = $1", [code]);
        const student = studentResult.rows[0];

        if (!student) return res.json({ success: false, message: "Code matricule incorrect" });

        let requestResult = await query("SELECT device_id, status, message FROM access_requests WHERE student_id = $1", [student.id]);
        const request = requestResult.rows[0];

        if (!request) {
            // Premier accès : on enregistre
            await query(`INSERT INTO access_requests (student_id, device_id, status) VALUES ($1, $2, 'PENDING')`, [student.id, device_id]);
            res.json({ success: true, student: { id: student.id, full_name: student.name, secret_code: code, status: 'PENDING' } });
        } else {
            if (request.device_id === device_id) {
                if (request.status === 'REJECTED') {
                    res.json({ success: true, student: { id: student.id, full_name: student.name, secret_code: code, status: 'REJECTED', message: request.message } });
                } else {
                    res.json({ success: true, student: { id: student.id, full_name: student.name, secret_code: code, status: request.status } });
                }
            } else {
                res.json({ success: false, message: "Ce code est déjà lié à un autre téléphone." });
            }
        }
    } catch (err) {
        console.error("Erreur Login:", err);
        res.status(500).json({ success: false, message: "Erreur serveur lors de la connexion." });
    }
});

// --- 6. ROUTE DONNÉES ÉLÈVE ---
app.get('/api/my-grades/:id', async (req, res) => {
    const studentId = req.params.id;

    try {
        const accessResult = await query("SELECT status, message FROM access_requests WHERE student_id = $1", [studentId]);
        const access = accessResult.rows[0];
        
        const isApproved = (access && access.status === 'APPROVED');
        const isRejected = (access && access.status === 'REJECTED');
        const rejectionMsg = (access && access.message) ? access.message : '';

        const studentResult = await query("SELECT code FROM students WHERE id = $1", [studentId]);
        const student = studentResult.rows[0];
        if (!student) return res.json({ error: "Élève introuvable" });
        const code = student.code;

        const notifsResult = await query("SELECT type, title, message, timestamp FROM notifications WHERE target_id = $1 OR target_id = 'ALL' ORDER BY id DESC", [code]);
        const absencesResult = await query("SELECT date, reason FROM absences WHERE student_id = $1", [code]);

        const notifs = notifsResult.rows;
        const absences = absencesResult.rows;

        if (isApproved) {
            const gradesResult = await query("SELECT subject, score FROM grades WHERE student_id = $1", [code]);
            res.json({ locked: false, notifications: notifs, absences: absences, grades: gradesResult.rows });
        } else {
            res.json({ 
                locked: true, 
                rejected: isRejected, 
                reject_reason: rejectionMsg, 
                notifications: notifs, 
                absences: absences, 
                grades: [] 
            });
        }
    } catch (err) {
        console.error("Erreur Données Élève:", err);
        res.status(500).json({ error: "Erreur serveur lors de la récupération des données." });
    }
});

// --- 7. ROUTES ADMIN (APPROBATION & REFUS) ---
app.get('/api/admin/requests', async (req, res) => {
    try {
        const sql = `SELECT ar.student_id, s.name, s.code, ar.status, ar.message, ar.request_date 
                     FROM access_requests ar 
                     JOIN students s ON ar.student_id = s.id 
                     ORDER BY ar.request_date DESC`;
        const result = await query(sql);
        res.json(result.rows);
    } catch (err) {
        console.error("Erreur Admin Requests:", err);
        res.status(500).json({ error: "Erreur serveur." });
    }
});

app.post('/api/admin/approve', async (req, res) => {
    const { student_id } = req.body;
    try {
        await query("UPDATE access_requests SET status = 'APPROVED', message = NULL WHERE student_id = $1", [student_id]);
        res.json({ success: true });
    } catch (err) {
        console.error("Erreur Approve:", err);
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/reject', async (req, res) => {
    const { student_id, reason } = req.body;
    console.log(`❌ Refus pour ID ${student_id}. Motif: ${reason}`);
    try {
        await query("UPDATE access_requests SET status = 'REJECTED', message = $1 WHERE student_id = $2", [reason, student_id]);
        res.json({ success: true });
    } catch (err) {
        console.error("Erreur Reject:", err);
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/reset', async (req, res) => {
    const { student_id } = req.body;
    try {
        await query("DELETE FROM access_requests WHERE student_id = $1", [student_id]);
        res.json({ success: true });
    } catch (err) {
        console.error("Erreur Reset:", err);
        res.status(500).json({ success: false });
    }
});

// --- AUTRES ROUTES ---
app.get('/api/students', async (req, res) => {
    try {
        const result = await query("SELECT * FROM students ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "Erreur serveur." }); }
});
app.post('/api/grades', async (req, res) => {
    try {
        await query(`INSERT INTO grades (student_id, subject, score) VALUES ($1, $2, $3)`, [req.body.student_id, req.body.subject, req.body.score]);
        res.json({ message: "OK" });
    } catch (err) { res.status(500).json({ error: "Erreur serveur." }); }
});
app.post('/api/absences', async (req, res) => {
    try {
        await query(`INSERT INTO absences (student_id, date, reason) VALUES ($1, $2, $3)`, [req.body.student_id, req.body.date, req.body.reason]);
        res.json({ message: "OK" });
    } catch (err) { res.status(500).json({ error: "Erreur serveur." }); }
});
app.post('/api/notifications', async (req, res) => {
    try {
        await query(`INSERT INTO notifications (type, title, message, target_id) VALUES ($1, $2, $3, $4)`, [req.body.type, req.body.title, req.body.message, req.body.target_id]);
        res.json({ message: "OK" });
    } catch (err) { res.status(500).json({ error: "Erreur serveur." }); }
});

// Lancement du serveur (Port Dynamique)
app.listen(PORT, () => {
    console.log(`🚀 Serveur Madrassati Pro prêt sur le port ${PORT}`);
});