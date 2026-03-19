#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULTS = {
  claude: {
    thinking: true,
    toolDisplay: true,
    toolBodyDisplay: false,
    debugLog: false,
    effort: 'high',
  },
  codex: {
    reasoning: true,
    toolDisplay: true,
    toolBodyDisplay: false,
    summary: 'detailed',
  },
};

const PRESETS = {
  fast: {
    claude: { thinking: false, toolDisplay: false, toolBodyDisplay: false, debugLog: false },
    codex: { reasoning: false, toolDisplay: false, toolBodyDisplay: false },
  },
  balanced: {
    claude: { thinking: false, toolDisplay: true, toolBodyDisplay: false, debugLog: false },
    codex: { reasoning: false, toolDisplay: true, toolBodyDisplay: false },
  },
  verbose: {
    claude: { thinking: true, toolDisplay: true, toolBodyDisplay: true, debugLog: false },
    codex: { reasoning: true, toolDisplay: true, toolBodyDisplay: true },
  },
};

const SETTERS = {
  'claude.thinking': 'boolean',
  'claude.toolDisplay': 'boolean',
  'claude.toolBodyDisplay': 'boolean',
  'claude.debugLog': 'boolean',
  'claude.effort': ['low', 'medium', 'high'],
  'codex.reasoning': 'boolean',
  'codex.toolDisplay': 'boolean',
  'codex.toolBodyDisplay': 'boolean',
  'codex.summary': 'string',
};

function deepMerge(base, patch) {
  const output = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = deepMerge(base[key] || {}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function loadConfig() {
  try {
    return deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}

function parseBoolean(value) {
  const normalized = String(value).toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(normalized)) return true;
  if (['off', 'false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseValue(key, raw) {
  const rule = SETTERS[key];
  if (!rule) throw new Error(`Unknown setting: ${key}`);
  if (rule === 'boolean') return parseBoolean(raw);
  if (rule === 'string') return String(raw);
  if (Array.isArray(rule) && rule.includes(raw)) return raw;
  throw new Error(`Invalid value for ${key}: ${raw}`);
}

function setPath(cfg, dottedKey, value) {
  const [section, field] = dottedKey.split('.');
  cfg[section] = cfg[section] || {};
  cfg[section][field] = value;
}

function usage(code = 0) {
  const lines = [
    'Usage:',
    '  node configure.mjs show',
    '  node configure.mjs fast',
    '  node configure.mjs balanced',
    '  node configure.mjs verbose',
    '  node configure.mjs set <key> <value>',
    '',
    'Examples:',
    '  node configure.mjs fast',
    '  node configure.mjs set claude.thinking off',
    '  node configure.mjs set codex.toolDisplay on',
    '  node configure.mjs set codex.toolBodyDisplay off',
    '  node configure.mjs set claude.effort medium',
  ];
  const out = lines.join('\n');
  if (code === 0) console.log(out);
  else console.error(out);
  process.exit(code);
}

const [command, key, rawValue] = process.argv.slice(2);

if (!command || ['help', '--help', '-h'].includes(command)) {
  usage(0);
}

const cfg = loadConfig();

if (command === 'show') {
  console.log(JSON.stringify(cfg, null, 2));
  process.exit(0);
}

if (PRESETS[command]) {
  const next = deepMerge(cfg, PRESETS[command]);
  saveConfig(next);
  console.log(JSON.stringify(next, null, 2));
  process.exit(0);
}

if (command === 'set') {
  if (!key || typeof rawValue === 'undefined') usage(1);
  const value = parseValue(key, rawValue);
  setPath(cfg, key, value);
  saveConfig(cfg);
  console.log(JSON.stringify(cfg, null, 2));
  process.exit(0);
}

usage(1);
