const express = require('express');
const initSqlJs = require('sql.js');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'sorteio.db');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('Apenas imagens são permitidas (jpg, png, gif, webp).'));
    }
  }
});

let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS participantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_completo TEXT NOT NULL UNIQUE,
      whatsapp TEXT NOT NULL,
      palavra_chave TEXT NOT NULL,
      print_path TEXT NOT NULL,
      criado_em TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  salvarDb();
}

function salvarDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

const ADMIN_PASSWORD = 'monstro20';
const tokens = new Set();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

app.post('/api/admin/login', (req, res) => {
  const { senha } = req.body;
  if (senha === ADMIN_PASSWORD) {
    const token = require('crypto').randomBytes(32).toString('hex');
    tokens.add(token);
    res.json({ sucesso: true, token });
  } else {
    res.status(401).json({ erro: 'Senha incorreta.' });
  }
});

function verificarAdmin(req, res, next) {
  const token = req.headers.authorization;
  if (!token || !tokens.has(token)) {
    return res.status(401).json({ erro: 'Acesso não autorizado.' });
  }
  next();
}

app.post('/api/participantes', (req, res) => {
  upload.single('print')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ erro: 'Imagem muito grande. Máximo 5MB.' });
      }
      return res.status(400).json({ erro: err.message });
    }

    const { nome_completo, whatsapp, palavra_chave } = req.body;

    if (!nome_completo || !whatsapp || !palavra_chave) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ erro: 'Todos os campos são obrigatórios.' });
    }

    if (!req.file) {
      return res.status(400).json({ erro: 'Envie o print do cadastro.' });
    }

    const nomeLimpo = nome_completo.trim();
    const whatsappLimpo = whatsapp.trim();
    const palavraLimpa = palavra_chave.trim();

    if (nomeLimpo.length < 4) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ erro: 'Digite seu nome completo (mínimo 4 caracteres).' });
    }

    if (palavraLimpa.length < 3) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ erro: 'A palavra-chave deve ter pelo menos 3 caracteres.' });
    }

    try {
      db.run(
        'INSERT INTO participantes (nome_completo, whatsapp, palavra_chave, print_path) VALUES (?, ?, ?, ?)',
        [nomeLimpo, whatsappLimpo, palavraLimpa, req.file.filename]
      );
      salvarDb();
      const result = db.exec('SELECT COUNT(*) as total FROM participantes');
      const total = result[0].values[0][0];
      res.json({ sucesso: true, total });
    } catch (err) {
      fs.unlinkSync(req.file.path);
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ erro: 'Você já está cadastrado.' });
      }
      res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  });
});

app.get('/api/participantes', (req, res) => {
  const result = db.exec(
    'SELECT id, nome_completo, print_path, criado_em FROM participantes ORDER BY criado_em DESC'
  );

  let participantes = [];
  if (result.length > 0) {
    const columns = result[0].columns;
    participantes = result[0].values.map(row => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  }

  const countResult = db.exec('SELECT COUNT(*) FROM participantes');
  const total = countResult.length > 0 ? countResult[0].values[0][0] : 0;

  res.json({ participantes, total });
});

app.get('/api/admin/participantes', verificarAdmin, (req, res) => {
  const result = db.exec(
    'SELECT id, nome_completo, whatsapp, palavra_chave, print_path, criado_em FROM participantes ORDER BY criado_em DESC'
  );

  let participantes = [];
  if (result.length > 0) {
    const columns = result[0].columns;
    participantes = result[0].values.map(row => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  }

  const countResult = db.exec('SELECT COUNT(*) FROM participantes');
  const total = countResult.length > 0 ? countResult[0].values[0][0] : 0;

  res.json({ participantes, total });
});

app.delete('/api/admin/zerar', verificarAdmin, (req, res) => {
  try {
    const prints = db.exec('SELECT print_path FROM participantes');
    if (prints.length > 0) {
      prints[0].values.forEach(row => {
        const filePath = path.join(UPLOADS_DIR, row[0]);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });
    }
    db.run('DELETE FROM participantes');
    salvarDb();
    res.json({ sucesso: true });
  } catch {
    res.status(500).json({ erro: 'Erro ao zerar a lista.' });
  }
});

initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
});
