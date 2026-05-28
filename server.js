const express = require('express');
const initSqlJs = require('sql.js');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Tesseract = require('tesseract.js');

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
    migrarDb();
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS participantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_completo TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      print_path TEXT NOT NULL,
      valor_deposito REAL DEFAULT 0,
      quantidade_nomes INTEGER DEFAULT 1,
      hash_print TEXT UNIQUE,
      status_ocr TEXT DEFAULT 'sucesso',
      criado_em TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  salvarDb();
}

function migrarDb() {
  try {
    const info = db.exec("PRAGMA table_info(participantes)");
    if (info.length === 0) return;
    const cols = info[0].values.map(r => r[1]);
    if (cols.includes('valor_deposito')) return;

    db.run('BEGIN TRANSACTION');
    db.run(`CREATE TABLE participantes_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_completo TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      print_path TEXT NOT NULL,
      valor_deposito REAL DEFAULT 0,
      quantidade_nomes INTEGER DEFAULT 1,
      hash_print TEXT UNIQUE,
      status_ocr TEXT DEFAULT 'sucesso',
      criado_em TEXT DEFAULT (datetime('now', 'localtime'))
    )`);
    db.run(`INSERT INTO participantes_v2 (id, nome_completo, whatsapp, print_path, criado_em)
      SELECT id, nome_completo, whatsapp, print_path, criado_em FROM participantes`);
    db.run('DROP TABLE participantes');
    db.run('ALTER TABLE participantes_v2 RENAME TO participantes');
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (e2) {}
  }
}

function salvarDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function calcularHash(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function processarOCR(imagePath) {
  try {
    const worker = await Tesseract.createWorker('por');
    const { data: { text } } = await worker.recognize(imagePath);
    await worker.terminate();

    const temSucesso = /sucesso/i.test(text);
    const temProcessando = /processando/i.test(text);

    const valores = [];
    const regex = /(\d{1,3}(?:\.\d{3})*,\d{2})/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const num = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
      if (!isNaN(num) && num > 0) valores.push(num);
    }

    const maiorValor = valores.length > 0 ? Math.max(...valores) : 0;

    return { sucesso: true, texto: text, temSucesso, temProcessando, valor: maiorValor };
  } catch (err) {
    return { sucesso: false, texto: '', temSucesso: false, temProcessando: false, valor: 0 };
  }
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
  upload.single('print')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ erro: 'Imagem muito grande. Máximo 5MB.' });
      }
      return res.status(400).json({ erro: err.message });
    }

    const { nome_completo, whatsapp } = req.body;

    if (!nome_completo || !whatsapp) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ erro: 'Nome e WhatsApp são obrigatórios.' });
    }

    if (!req.file) {
      return res.status(400).json({ erro: 'Envie o print do depósito.' });
    }

    const nomeLimpo = nome_completo.trim();
    const whatsappLimpo = whatsapp.trim();

    if (nomeLimpo.length < 4) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ erro: 'Digite seu nome completo (mínimo 4 caracteres).' });
    }

    const hash = calcularHash(req.file.path);

    const duplicado = db.exec('SELECT id FROM participantes WHERE hash_print = ?', [hash]);
    if (duplicado.length > 0 && duplicado[0].values.length > 0) {
      fs.unlinkSync(req.file.path);
      return res.status(409).json({ erro: 'Este comprovante já foi enviado anteriormente.' });
    }

    const ocr = await processarOCR(req.file.path);

    if (!ocr.sucesso) {
      fs.unlinkSync(req.file.path);
      return res.status(422).json({
        erro: 'Não foi possível ler o comprovante automaticamente. Envie uma imagem mais nítida.',
        ocr_falhou: true
      });
    }

    if (!ocr.temSucesso) {
      const msg = ocr.temProcessando
        ? 'O depósito ainda está com status "Processando". Aguarde a confirmação e tente novamente.'
        : 'Não foi possível identificar o status "Sucesso" no comprovante. Verifique se o depósito foi confirmado.';
      fs.unlinkSync(req.file.path);
      return res.status(422).json({ erro: msg, ocr_falhou: true });
    }

    if (ocr.valor <= 0) {
      fs.unlinkSync(req.file.path);
      return res.status(422).json({
        erro: 'Não foi possível identificar o valor do depósito no comprovante. Envie uma imagem mais nítida.',
        ocr_falhou: true
      });
    }

    if (ocr.valor < 20) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ erro: `Valor detectado: R$${ocr.valor.toFixed(2).replace('.', ',')}. O valor mínimo para participar é R$20,00.` });
    }

    const quantidadeNomes = Math.floor(ocr.valor / 20);

    try {
      db.run(
        `INSERT INTO participantes (nome_completo, whatsapp, print_path, valor_deposito, quantidade_nomes, hash_print, status_ocr)
         VALUES (?, ?, ?, ?, ?, ?, 'sucesso')`,
        [nomeLimpo, whatsappLimpo, req.file.filename, ocr.valor, quantidadeNomes, hash]
      );
      salvarDb();

      const result = db.exec('SELECT SUM(quantidade_nomes) as total FROM participantes');
      const total = result[0].values[0][0] || 0;

      res.json({
        sucesso: true,
        total,
        valor_detectado: ocr.valor,
        quantidade_nomes: quantidadeNomes
      });
    } catch (err) {
      fs.unlinkSync(req.file.path);
      if (err.message.includes('UNIQUE constraint failed: participantes.hash_print')) {
        return res.status(409).json({ erro: 'Este comprovante já foi enviado anteriormente.' });
      }
      res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  });
});

app.get('/api/participantes', (req, res) => {
  const result = db.exec(`
    SELECT nome_completo, SUM(quantidade_nomes) as total_nomes, MIN(id) as id, GROUP_CONCAT(print_path) as prints
    FROM participantes
    GROUP BY nome_completo
    ORDER BY MIN(criado_em) DESC
  `);

  let participantes = [];
  if (result.length > 0) {
    const columns = result[0].columns;
    participantes = result[0].values.map(row => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      obj.print_path = obj.prints ? obj.prints.split(',')[0] : '';
      return obj;
    });
  }

  const countResult = db.exec('SELECT SUM(quantidade_nomes) FROM participantes');
  const total = countResult.length > 0 ? (countResult[0].values[0][0] || 0) : 0;

  res.json({ participantes, total });
});

app.get('/api/admin/participantes', verificarAdmin, (req, res) => {
  const result = db.exec(
    'SELECT id, nome_completo, whatsapp, print_path, valor_deposito, quantidade_nomes, status_ocr, criado_em FROM participantes ORDER BY criado_em DESC'
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

  const countResult = db.exec('SELECT SUM(quantidade_nomes) FROM participantes');
  const total = countResult.length > 0 ? (countResult[0].values[0][0] || 0) : 0;

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
