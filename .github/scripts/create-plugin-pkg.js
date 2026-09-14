const fs = require('fs');
const path = require('path');

const PLUGIN_SRC = 'plugins/munin-claude-code';
const STAGING_DIR = '/tmp/munin-pkg';

const pluginJson = JSON.parse(
  fs.readFileSync(`${PLUGIN_SRC}/.claude-plugin/plugin.json`, 'utf8')
);

const pkg = {
  // ⚠️ DO NOT rename to '@kalera/munin-claude'. That npm name belongs to the
  // ADAPTER CLI (adapters/claude, `bin: munin-claude`), which the plugin invokes
  // at runtime via `npx @kalera/munin-claude` (.mcp.json + session-start hook).
  // Publishing the plugin under that name overwrites the CLI and breaks recall.
  // The '-plugin' suffix keeps the two npm packages distinct on purpose.
  name: '@kalera/munin-claude-plugin',
  version: pluginJson.version,
  description: pluginJson.description || '',
  author: pluginJson.author
    ? `${pluginJson.author.name} <${pluginJson.author.email}>`
    : 'Kalera <hoang.kal@gmail.com>',
  license: pluginJson.license || 'MIT',
  repository: pluginJson.repository || 'https://github.com/kalera-labs/munin-for-agents',
  homepage: pluginJson.repository
    ? pluginJson.repository.replace('.git', '') + '#readme'
    : 'https://github.com/kalera-labs/munin-for-agents#readme',
  keywords: pluginJson.keywords || [],
  files: ['plugins/munin-claude-code'],
  main: 'plugins/munin-claude-code/.claude-plugin/plugin.json',
};

fs.rmSync(STAGING_DIR, { recursive: true, force: true });
fs.mkdirSync(`${STAGING_DIR}/plugins`, { recursive: true });
fs.cpSync(PLUGIN_SRC, `${STAGING_DIR}/plugins/munin-claude-code`, { recursive: true });
fs.writeFileSync(`${STAGING_DIR}/package.json`, JSON.stringify(pkg, null, 2));

console.log('Staged package at', STAGING_DIR);
console.log('Version:', pkg.version);
console.log('Package name:', pkg.name);