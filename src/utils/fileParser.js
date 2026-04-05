const fs = require('fs');
const path = require('path');

// Supported file types and their "kind" labels
const FILE_TYPE_MAP = {
  '.js': 'code',
  '.ts': 'code',
  '.jsx': 'code',
  '.tsx': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.py': 'code',
  '.java': 'code',
  '.go': 'code',
  '.rb': 'code',
  '.php': 'code',
  '.cs': 'code',
  '.cpp': 'code',
  '.c': 'code',
  '.rs': 'code',
  '.json': 'config',
  '.yaml': 'config',
  '.yml': 'config',
  '.env': 'config',
  '.toml': 'config',
  '.xml': 'config',
  '.md': 'documentation',
  '.txt': 'documentation',
  '.log': 'log',
  '.sql': 'schema',
  '.graphql': 'schema',
  '.gql': 'schema',
  '.sh': 'script',
  '.bash': 'script',
};

const CHUNK_SIZE = 1500;   // characters per chunk
const CHUNK_OVERLAP = 200; // overlap between chunks

/**
 * Parse a file and return structured chunks for indexing
 */
function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const kind = FILE_TYPE_MAP[ext] || 'unknown';
  const filename = path.basename(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');

  if (!content.trim()) return [];

  const chunks = chunkContent(content, filePath);

  return chunks.map((chunk, idx) => ({
    id: `${filePath}::chunk${idx}`,
    filePath,
    filename,
    ext,
    kind,
    chunkIndex: idx,
    totalChunks: chunks.length,
    content: chunk,
    lines: countLines(chunk),
    ingestedAt: new Date().toISOString(),
    // Extract code-specific metadata
    metadata: extractMetadata(chunk, kind, filename),
  }));
}

/**
 * Split content into overlapping chunks
 */
function chunkContent(content, filePath) {
  const lines = content.split('\n');

  // For small files, keep as single chunk
  if (content.length <= CHUNK_SIZE) return [content];

  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const line of lines) {
    current.push(line);
    currentLen += line.length + 1;

    if (currentLen >= CHUNK_SIZE) {
      chunks.push(current.join('\n'));
      // Keep last N chars for overlap
      const overlapLines = [];
      let overlapLen = 0;
      for (let i = current.length - 1; i >= 0 && overlapLen < CHUNK_OVERLAP; i--) {
        overlapLines.unshift(current[i]);
        overlapLen += current[i].length + 1;
      }
      current = overlapLines;
      currentLen = overlapLen;
    }
  }

  if (current.length > 0) {
    chunks.push(current.join('\n'));
  }

  return chunks;
}

/**
 * Extract metadata from file content based on its type
 */
function extractMetadata(content, kind, filename) {
  const meta = {};

  if (kind === 'code') {
    // Extract function/class names
    const functions = [];
    const classes = [];
    const imports = [];
    const exports = [];

    const fnMatches = content.matchAll(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\(|(\w+)\s*\([^)]*\)\s*{)/g);
    for (const m of fnMatches) {
      const name = m[1] || m[2] || m[3];
      if (name && !['if', 'for', 'while', 'switch', 'catch'].includes(name)) {
        functions.push(name);
      }
    }

    const classMatches = content.matchAll(/class\s+(\w+)/g);
    for (const m of classMatches) classes.push(m[1]);

    const importMatches = content.matchAll(/(?:import|require)\s*(?:\{[^}]+\}|[\w*]+)?\s*(?:from)?\s*['"]([^'"]+)['"]/g);
    for (const m of importMatches) imports.push(m[1]);

    const exportMatches = content.matchAll(/export\s+(?:default\s+)?(?:function|class|const|let|var)?\s*(\w+)/g);
    for (const m of exportMatches) exports.push(m[1]);

    // Extract error types mentioned
    const errors = [];
    const errorMatches = content.matchAll(/(?:catch|throw|Error|Exception)\s*[(\s]*([A-Z]\w+(?:Error|Exception))/g);
    for (const m of errorMatches) errors.push(m[1]);

    meta.functions = [...new Set(functions)].slice(0, 20);
    meta.classes = [...new Set(classes)].slice(0, 10);
    meta.imports = [...new Set(imports)].slice(0, 20);
    meta.exports = [...new Set(exports)].slice(0, 10);
    meta.errors = [...new Set(errors)].slice(0, 10);

    // Detect API patterns
    const apiPatterns = [];
    if (/express|router\.(get|post|put|delete|patch)/i.test(content)) apiPatterns.push('REST API');
    if (/graphql|resolver|schema/i.test(content)) apiPatterns.push('GraphQL');
    if (/mongoose|sequelize|prisma|typeorm/i.test(content)) apiPatterns.push('ORM');
    if (/redis|ioredis|bull/i.test(content)) apiPatterns.push('Cache/Queue');
    if (/jwt|passport|bcrypt/i.test(content)) apiPatterns.push('Auth');
    meta.patterns = apiPatterns;

  } else if (kind === 'log') {
    // Extract error/warning lines
    const errorLines = content
      .split('\n')
      .filter(l => /error|exception|warn|fail|crash/i.test(l))
      .slice(0, 10);
    meta.errors = errorLines;

    // Extract timestamps if present
    const hasTimestamps = /\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/.test(content);
    meta.hasTimestamps = hasTimestamps;

  } else if (kind === 'schema') {
    // Extract table/model names
    const tables = [];
    const tableMatches = content.matchAll(/(?:CREATE\s+TABLE|model\s+|type\s+)["'`]?(\w+)["'`]?/gi);
    for (const m of tableMatches) tables.push(m[1]);
    meta.tables = [...new Set(tables)].slice(0, 20);
  }

  // Detect if this looks like a bug fix / patch
  meta.isBugFix = /fix|bug|patch|resolve|hotfix|issue/i.test(filename) ||
    /TODO|FIXME|HACK|BUG|XXX/.test(content);

  return meta;
}

function countLines(text) {
  return text.split('\n').length;
}

/**
 * Check if a file should be skipped
 */
function shouldSkip(filePath) {
  const skipPatterns = [
    /node_modules/,
    /\.git\//,
    /dist\//,
    /build\//,
    /coverage\//,
    /\.min\.(js|css)$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /\.map$/,
  ];
  return skipPatterns.some(p => p.test(filePath));
}

module.exports = { parseFile, shouldSkip, FILE_TYPE_MAP };
