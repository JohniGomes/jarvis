// Carrega o TSV de "Sem Corridas" já coletado manualmente (antes do robô
// diário existir) direto no Supabase. Uso único.
// node --env-file=... scripts/backfill-sem-corridas-tsv.mjs <caminho.tsv>

import { readFileSync } from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const tsvPath = process.argv[2];
if (!tsvPath) { console.error('Uso: node backfill-sem-corridas-tsv.mjs <caminho.tsv>'); process.exit(1); }

function toIsoDate(brDate) {
  const m = String(brDate || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const raw = readFileSync(tsvPath, 'utf8').replace(/^﻿/, '');
const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
const headers = lines[0].split('\t');
const rows = lines.slice(1).map((line) => {
  const cols = line.split('\t');
  const obj = {};
  headers.forEach((h, i) => { obj[h] = cols[i]; });
  return {
    cpf: String(obj.CPF || '').replace(/\D/g, '').padStart(11, '0'),
    nome: obj.Nome,
    telefone: String(obj.Telefone || '').replace(/\D/g, '') || null,
    praca: obj.Praca || null,
    aprovado_em: toIsoDate(obj.Aprovado_em),
    corridas: 0,
  };
});

const res = await fetch(`${SUPABASE_URL}/rest/v1/sem_corridas?on_conflict=cpf`, {
  method: 'POST',
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  },
  body: JSON.stringify(rows),
});
if (!res.ok) {
  console.error(await res.text());
  process.exit(1);
}
console.log(`sem_corridas: ${rows.length} linhas enviadas.`);
