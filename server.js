const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const EXCEL_FILE = path.join(ROOT, "baza.xlsx");
const RESULTS_FILE = path.join(ROOT, "results.json");
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const ADMIN_COOKIE = "admin_session";
const ADMIN_SESSION = process.env.ADMIN_SESSION || Math.random().toString(36).slice(2);

const OPEN_QUESTION_KEYS = [
  "leaveReason",
  "hrPractice",
  "stayReason",
  "extraComment"
];

let cache = null;

function readZipEntries(filePath) {
  const data = fs.readFileSync(filePath);
  const entries = new Map();
  let offset = 0;

  while (offset < data.length - 4) {
    const signature = data.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;

    const method = data.readUInt16LE(offset + 8);
    const compressedSize = data.readUInt32LE(offset + 18);
    const fileNameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = data.slice(nameStart, nameStart + fileNameLength).toString("utf8");
    const contentStart = nameStart + fileNameLength + extraLength;
    const content = data.slice(contentStart, contentStart + compressedSize);

    if (method === 0) entries.set(name, content);
    if (method === 8) entries.set(name, zlib.inflateRawSync(content));

    offset = contentStart + compressedSize;
  }

  return entries;
}

function attrs(xml) {
  const result = {};
  for (const match of xml.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    result[match[1]] = decodeXml(match[2]);
  }
  return result;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function columnNumber(cellRef) {
  const letters = String(cellRef).match(/[A-Z]+/i)?.[0] || "A";
  return [...letters.toUpperCase()].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
}

function parseSharedStrings(xml) {
  const strings = [];
  for (const item of xml.matchAll(/<si[\s\S]*?<\/si>/g)) {
    const text = [...item[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((part) => decodeXml(part[1]))
      .join("");
    strings.push(text);
  }
  return strings;
}

function parseRows(sheetXml, sharedStrings) {
  const rows = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
    const values = {};
    for (const cellMatch of rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const cellAttrs = attrs(cellMatch[1]);
      const cellBody = cellMatch[2];
      const index = columnNumber(cellAttrs.r);
      const rawValue = cellBody.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "";
      const inline = cellBody.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || "";
      let value = decodeXml(rawValue || inline);

      if (cellAttrs.t === "s" && rawValue !== "") value = sharedStrings[Number(rawValue)] || "";
      values[index] = value.trim();
    }

    const max = Math.max(0, ...Object.keys(values).map(Number));
    if (max) rows.push(Array.from({ length: max }, (_, index) => values[index + 1] || ""));
  }
  return rows;
}

function parseWorkbook() {
  const entries = readZipEntries(EXCEL_FILE);
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8") || "");
  const sheet = entries.get("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("Excel fayl ichida sheet1.xml topilmadi.");
  return parseRows(sheet.toString("utf8"), sharedStrings);
}

function normalizeTarget(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("qisqa")) return "qisqa";
  if (text.includes("uzoq")) return "uzoq";
  if (text.includes("orta") || text.includes("o'rta") || text.includes("o‘rta")) return "orta";
  return "";
}

function displayTarget(key) {
  return {
    qisqa: "Qisqa muddatli",
    orta: "O'rta muddatli",
    uzoq: "Uzoq muddatli"
  }[key] || "Aniqlanmadi";
}

function cleanExcelText(value, fallback = "") {
  return String(value || fallback)
    .replace(/\uFFFD/g, "'")
    .replace(/�/g, "'")
    .trim();
}

function readResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function writeResults(results) {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), "utf8");
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

function resultsToCsv(results, model) {
  const headers = [
    "Sana",
    "Ism",
    "Familya",
    "Natija",
    "Guruh kodi",
    "Confidence",
    "Namunalar",
    ...model.features.map((feature) => feature.label),
    ...model.openQuestions.map((question) => question.label)
  ];

  const rows = results.map((item) => [
    item.createdAt,
    item.person?.firstName,
    item.person?.lastName,
    item.result,
    item.key,
    item.confidence,
    item.samples,
    ...model.features.map((feature) => item.answers?.[feature.key] || ""),
    ...model.openQuestions.map((question) => item.openAnswers?.[question.key] || "")
  ]);

  return "\uFEFF" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function majority(rows) {
  const counts = {};
  for (const row of rows) counts[row.target] = (counts[row.target] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "orta";
}

function entropy(rows) {
  const counts = {};
  for (const row of rows) counts[row.target] = (counts[row.target] || 0) + 1;
  return Object.values(counts).reduce((sum, count) => {
    const p = count / rows.length;
    return sum - p * Math.log2(p);
  }, 0);
}

function splitRows(rows, feature) {
  const groups = new Map();
  for (const row of rows) {
    const raw = row.answers[feature.key];
    const value = feature.type === "number" ? String(Number(raw || 0)) : String(raw || "Noma'lum");
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

function informationGain(rows, feature) {
  const base = entropy(rows);
  const groups = splitRows(rows, feature);
  let remainder = 0;
  for (const group of groups.values()) {
    remainder += (group.length / rows.length) * entropy(group);
  }
  return base - remainder;
}

function buildTree(rows, features, depth = 0) {
  const nodeMajority = majority(rows);
  const uniqueTargets = new Set(rows.map((row) => row.target));
  if (uniqueTargets.size === 1 || depth >= 7 || features.length === 0 || rows.length < 3) {
    return { type: "leaf", prediction: nodeMajority, samples: rows.length };
  }

  const ranked = features
    .map((feature) => ({ feature, gain: informationGain(rows, feature) }))
    .sort((a, b) => b.gain - a.gain);
  const best = ranked[0];
  if (!best || best.gain <= 0.0001) return { type: "leaf", prediction: nodeMajority, samples: rows.length };

  const groups = splitRows(rows, best.feature);
  const remaining = features.filter((feature) => feature.key !== best.feature.key);
  const branches = {};
  for (const [value, group] of groups) {
    branches[value] = buildTree(group, remaining, depth + 1);
  }

  return {
    type: "decision",
    featureKey: best.feature.key,
    featureLabel: best.feature.label,
    fallback: nodeMajority,
    samples: rows.length,
    branches
  };
}

function predict(tree, answers, featuresByKey) {
  const path = [];
  let node = tree;

  while (node.type === "decision") {
    const feature = featuresByKey[node.featureKey];
    const value = feature?.type === "number"
      ? String(Number(answers[node.featureKey] || 0))
      : String(answers[node.featureKey] || "Noma'lum");
    path.push({ label: node.featureLabel, value });
    node = node.branches[value] || { type: "leaf", prediction: node.fallback, samples: node.samples };
  }

  return { prediction: node.prediction, samples: node.samples, path };
}

function topFactors(training, features) {
  const ranked = features
    .map((feature) => ({ key: feature.key, label: feature.label, gain: informationGain(training, feature) }))
    .filter((item) => Number.isFinite(item.gain) && item.gain > 0)
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 3);
  const maxGain = ranked[0]?.gain || 1;
  return ranked.map((item) => ({
    key: item.key,
    label: item.label,
    score: Math.max(1, Math.round((item.gain / maxGain) * 100))
  }));
}

function loadModel() {
  const stat = fs.statSync(EXCEL_FILE);
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.model;

  const rows = parseWorkbook();
  const headers = rows[0] || [];
  const dataRows = rows.slice(1).filter((row) => row.some((value) => String(value || "").trim()));
  const features = [];
  const openQuestions = OPEN_QUESTION_KEYS.map((key, index) => ({
    key,
    label: cleanExcelText(headers[index + 27], `Ochiq savol ${index + 1}`)
  }));

  for (let index = 1; index <= 26; index += 1) {
    const sampleValues = dataRows.map((row) => row[index]).filter(Boolean);
    const numeric = index >= 5 && index <= 26;
    features.push({
      key: `c${index}`,
      column: index + 1,
      label: cleanExcelText(headers[index], `Savol ${index}`),
      type: numeric ? "number" : "category",
      options: numeric
        ? ["1", "2", "3", "4", "5"]
        : [...new Set(sampleValues)].filter(Boolean)
    });
  }

  const training = dataRows
    .map((row) => {
      const answers = {};
      for (let index = 1; index <= 26; index += 1) answers[`c${index}`] = row[index] || "";
      return { answers, target: normalizeTarget(row[32] || row[31]) };
    })
    .filter((row) => row.target);

  const tree = buildTree(training, features);
  const featuresByKey = Object.fromEntries(features.map((feature) => [feature.key, feature]));
  const distribution = training.reduce((acc, row) => {
    acc[row.target] = (acc[row.target] || 0) + 1;
    return acc;
  }, {});
  const factors = topFactors(training, features);

  cache = {
    mtimeMs: stat.mtimeMs,
    model: { features, featuresByKey, openQuestions, training, tree, distribution, factors }
  };
  return cache.model;
}

function modelSummary(model) {
  const total = model.training.length || 1;
  const clusters = ["qisqa", "orta", "uzoq"].map((key) => ({
    key,
    label: displayTarget(key),
    count: model.distribution[key] || 0,
    percent: Math.round(((model.distribution[key] || 0) / total) * 100)
  }));
  const highestRisk = clusters.slice().sort((a, b) => b.count - a.count)[0];
  const results = readResults();

  return {
    modelName: "Decision Tree",
    source: path.basename(EXCEL_FILE),
    totalTraining: model.training.length,
    resultsCount: results.length,
    questionsCount: model.features.length,
    openQuestionsCount: model.openQuestions.length,
    clusters,
    highestRisk,
    factors: model.factors
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim().split("="))
    .filter((parts) => parts.length === 2)
    .map(([key, value]) => [key, decodeURIComponent(value)]));
}

function isAdmin(req) {
  return parseCookies(req)[ADMIN_COOKIE] === ADMIN_SESSION;
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  sendJson(res, 401, { error: "Admin panelga kirish talab qilinadi." });
  return false;
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function staticFile(req, res) {
  const requested = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8"
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(content);
  });
}

async function handleRequest(req, res) {
  try {
    if (req.url === "/api/admin/session" && req.method === "GET") {
      sendJson(res, 200, { authenticated: isAdmin(req) });
      return;
    }

    if (req.url === "/api/admin/login" && req.method === "POST") {
      const body = JSON.parse(await collectBody(req) || "{}");
      const username = String(body.username || "").trim();
      const password = String(body.password || "");

      if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
        sendJson(res, 401, { error: "Login yoki parol noto'g'ri." });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `${ADMIN_COOKIE}=${encodeURIComponent(ADMIN_SESSION)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
      });
      res.end(JSON.stringify({ authenticated: true }));
      return;
    }

    if (req.url === "/api/admin/logout" && req.method === "POST") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
      });
      res.end(JSON.stringify({ authenticated: false }));
      return;
    }

    if (req.url === "/api/summary" && req.method === "GET") {
      const model = loadModel();
      sendJson(res, 200, modelSummary(model));
      return;
    }

    if (req.url === "/api/questions" && req.method === "GET") {
      const model = loadModel();
      sendJson(res, 200, {
        features: model.features,
        openQuestions: model.openQuestions,
        distribution: model.distribution,
        total: model.training.length
      });
      return;
    }

    if (req.url === "/api/predict" && req.method === "POST") {
      const model = loadModel();
      const body = JSON.parse(await collectBody(req) || "{}");
      const person = {
        firstName: String(body.person?.firstName || "").trim(),
        lastName: String(body.person?.lastName || "").trim()
      };

      if (!person.firstName || !person.lastName) {
        sendJson(res, 400, { error: "Ism va familyani kiriting." });
        return;
      }

      const result = predict(model.tree, body.answers || {}, model.featuresByKey);
      const total = model.training.length;
      const classCount = model.distribution[result.prediction] || 0;
      const payload = {
        key: result.prediction,
        result: displayTarget(result.prediction),
        confidence: Math.round((classCount / total) * 100),
        samples: result.samples,
        path: result.path.slice(0, 4),
        openAnswers: body.openAnswers || {}
      };
      const savedResult = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        createdAt: new Date().toISOString(),
        person,
        answers: body.answers || {},
        openAnswers: body.openAnswers || {},
        ...payload
      };
      const savedResults = readResults();
      savedResults.unshift(savedResult);
      writeResults(savedResults);

      sendJson(res, 200, payload);
      return;
    }

    if (req.url === "/api/admin/results" && req.method === "GET") {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 200, { results: readResults() });
      return;
    }

    if (req.url === "/api/admin/results.csv" && req.method === "GET") {
      if (!requireAdmin(req, res)) return;
      const model = loadModel();
      const csv = resultsToCsv(readResults(), model);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"natijalar.csv\""
      });
      res.end(csv);
      return;
    }

    staticFile(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

function listen(port, attemptsLeft = 10) {
  const server = http.createServer(handleRequest);

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.log(`${port}-port band, ${port + 1}-port sinab ko'rilmoqda...`);
      listen(port + 1, attemptsLeft - 1);
      return;
    }

    throw error;
  });

  server.listen(port, () => {
    console.log(`Server ishga tushdi: http://localhost:${port}`);
  });
}

listen(Number(PORT));
