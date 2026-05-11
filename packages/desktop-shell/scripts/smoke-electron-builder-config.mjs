#!/usr/bin/env node
/**
 * Static validation of the electron-builder config in package.json.
 *
 * Runs WITHOUT invoking electron-builder (no network, no native build).
 * Asserts the config shape is correct so the actual `npm run dist:win`
 * build won't fail on missing fields or wrong glob.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) { asserts++; if (c) { console.log(`  ok    ${l}`); } else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

console.log('==> Section A: scripts');
ok(typeof pkg.scripts['dist:win'] === 'string',     'A scripts.dist:win exists');
ok(typeof pkg.scripts['dist:mac'] === 'string',     'A scripts.dist:mac exists');
ok(typeof pkg.scripts['dist:dir'] === 'string',     'A scripts.dist:dir exists');
ok(pkg.scripts['dist:win'].includes('--win nsis'), 'A dist:win targets nsis');

console.log('==> Section B: top-level build fields');
ok(pkg.build && typeof pkg.build === 'object',     'B build field exists');
ok(pkg.build.appId === 'ai.renlab.cairn',          'B appId is ai.renlab.cairn');
ok(pkg.build.productName === 'Cairn',              'B productName is Cairn');
ok(typeof pkg.build.copyright === 'string',        'B copyright set');
ok(pkg.build.directories?.output === 'dist',       'B output dir = dist');
ok(pkg.build.directories?.buildResources === 'build', 'B buildResources = build');

console.log('==> Section C: files glob');
const files = pkg.build.files;
ok(Array.isArray(files) && files.length > 0,       'C files glob is non-empty array');
ok(files.includes('main.cjs'),                     'C files includes main.cjs');
ok(files.includes('preload.cjs'),                  'C files includes preload.cjs');
ok(files.includes('panel.html'),                   'C files includes panel.html');
ok(files.includes('panel.js'),                     'C files includes panel.js');
ok(files.some(f => f.includes('better-sqlite3')),  'C files includes better-sqlite3');
ok(files.some(f => f.startsWith('!')),             'C has negation patterns for exclusion');
ok(files.includes('*.cjs'),                         'C files glob covers all top-level .cjs modules (regression guard)');
ok(files.some(f => f.startsWith('agent-adapters')), 'C files glob includes agent-adapters/');

console.log('==> Section D: Windows target');
ok(Array.isArray(pkg.build.win?.target),           'D win.target is array');
const winTargets = pkg.build.win.target;
ok(winTargets.some(t => t.target === 'nsis'),      'D win includes nsis target');
ok(winTargets.some(t => Array.isArray(t.arch) && t.arch.includes('x64')), 'D win nsis target has x64 arch');
ok(pkg.build.win?.icon === 'build/icon.ico',       'D win.icon = build/icon.ico');

console.log('==> Section E: NSIS config');
const nsis = pkg.build.nsis;
ok(nsis && typeof nsis === 'object',               'E nsis section exists');
ok(nsis.oneClick === false,                        'E nsis.oneClick = false (user can choose install dir)');
ok(nsis.perMachine === false,                      'E nsis.perMachine = false (installs to %LOCALAPPDATA% per plan §1)');
ok(nsis.allowToChangeInstallationDirectory === true, 'E allowToChangeInstallationDirectory = true');
ok(nsis.createDesktopShortcut === true,            'E createDesktopShortcut = true');
ok(nsis.createStartMenuShortcut === true,          'E createStartMenuShortcut = true');
ok(nsis.installerIcon === 'build/icon.ico',        'E nsis.installerIcon set');
ok(nsis.uninstallerIcon === 'build/icon.ico',      'E nsis.uninstallerIcon set');

console.log('==> Section F: Mac target (config only, no build from this machine)');
ok(Array.isArray(pkg.build.mac?.target),           'F mac.target is array');
ok(pkg.build.mac.target.some(t => t.target === 'dmg'), 'F mac includes dmg target');
ok(pkg.build.mac?.icon === 'build/icon.icns',      'F mac.icon = build/icon.icns');

console.log('==> Section G: asar config');
ok(pkg.build.asar === true,                        'G asar enabled');
ok(Array.isArray(pkg.build.asarUnpack),            'G asarUnpack is array');
ok(pkg.build.asarUnpack.some(p => p.includes('better-sqlite3')), 'G better-sqlite3 unpacked from asar (native binding)');

console.log('==> Section H: build resources on disk');
const iconPath = path.join(root, 'build', 'icon.ico');
ok(fs.existsSync(iconPath),                        'H build/icon.ico exists on disk');
const iconStat = fs.statSync(iconPath);
ok(iconStat.size > 100,                            'H icon.ico is non-trivial size (>100 bytes)');
const iconBuf = fs.readFileSync(iconPath);
ok(iconBuf[0] === 0 && iconBuf[1] === 0 && iconBuf[2] === 1, 'H icon.ico has valid ICONDIR header');

console.log('==> Section I: metadata');
ok(typeof pkg.description === 'string' && pkg.description.length > 10, 'I package.json has description');
ok(typeof pkg.author === 'string',                 'I package.json has author');
ok(pkg.license === 'Apache-2.0',                   'I license = Apache-2.0');

console.log('');
console.log('========================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
console.log('========================================');
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
