const fs = require('fs');
const path = require('path');

const PLUGIN_SRC = 'plugins/munin-claude-code';
const STAGING_DIR = '/tmp/munin-pkg';

const pluginJson = JSON.parse(
  fs.readFileSync(`${PLUGIN_SRC}/.claude-plugin/plugin.json`, 'utf8')
);

const pkg = {
  name: '@kalera/munin-claude',
  version: pluginJson.version,
  description: pluginJson.description || '',
  author: pluginJson.author
    ? `${pluginJson.author.name} <${pluginJson.author.email}>`
    : 'Kalera <hoang.kal@gmail.com>',
  license: pluginJson.license || 'MIT',
  repository: pluginJson.repository || 'https://github.com/3d-era/munin-for-agents',
  homepage: pluginJson.repository
    ? pluginJson.repository.replace('.git', '') + '#readme'
    : 'https://github.com/3d-era/munin-for-agents#readme',
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