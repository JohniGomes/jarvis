// Migração pontual: lê o D-1/Entregadores/Sem Corridas que já estão na
// planilha (via o mesmo endpoint público do Apps Script que o painel usa) e
// faz upsert no Supabase, pra não perder o histórico já coletado antes dos
// robôs diários entrarem em ação.
//
// Uso: node --env-file="../automacao/.env" scripts/backfill-from-sheets.mjs

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwrec_feoCSZ6yP9Yymoz_A-c6zZySZjeqZz4Hf-5FndLGLC8_6qp2siI5foTzykF1LFQ/exec';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no ambiente (--env-file).');
  process.exit(1);
}

function padDigits11(val) {
  const digits = String(val || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.padStart(11, '0');
}

function toIsoDate(brDate) {
  const m = String(brDate || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

async function upsert(table, rows, conflictCols) {
  if (!rows.length) { console.log(`${table}: nada pra enviar.`); return; }
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictCols}`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Falha ao upsert em ${table} (lote ${i}-${i + chunk.length}): ${res.status} ${text}`);
    }
    console.log(`${table}: enviado lote ${i + chunk.length}/${rows.length}`);
  }
}

async function main() {
  console.log('Buscando dados do Apps Script (Dashboard)...');
  const dashRes = await fetch(`${APPS_SCRIPT_URL}?tab=Dashboard`);
  const dash = await dashRes.json();
  if (dash.error) throw new Error('Apps Script (Dashboard) retornou erro: ' + dash.error);

  function normName(name) {
    return String(name || '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
  }

  const d1RowsRaw = (dash.d1 || []).map((r) => ({
    data_do_periodo: toIsoDate(r.data_do_periodo),
    periodo: r.periodo,
    duracao_do_periodo: r.duracao_do_periodo || null,
    numero_minimo_de_entregadores_regulares_na_escala: r.numero_minimo_de_entregadores_regulares_na_escala ?? null,
    id_da_pessoa_entregadora: r.id_da_pessoa_entregadora ? String(r.id_da_pessoa_entregadora) : null,
    pessoa_entregadora: r.pessoa_entregadora,
    sub_praca: r.sub_praca || null,
    tempo_disponivel_escalado: r.tempo_disponivel_escalado ?? null,
    tempo_disponivel_absoluto: r.tempo_disponivel_absoluto || null,
    numero_de_corridas_ofertadas: r.numero_de_corridas_ofertadas ?? 0,
    numero_de_corridas_aceitas: r.numero_de_corridas_aceitas ?? 0,
    numero_de_corridas_rejeitadas: r.numero_de_corridas_rejeitadas ?? 0,
    numero_de_corridas_completadas: r.numero_de_corridas_completadas ?? 0,
    numero_de_corridas_canceladas_pela_pessoa_entregadora: r.numero_de_corridas_canceladas_pela_pessoa_entregadora ?? 0,
    numero_de_pedidos_aceitos_e_concluidos: r.numero_de_pedidos_aceitos_e_concluidos ?? 0,
  })).filter((r) => r.data_do_periodo && r.pessoa_entregadora);

  // A planilha foi montada colando vários bundles (jun/jul/ago) e algumas
  // datas se sobrepuseram entre eles -- dedupe pela mesma chave natural da
  // tabela, mantendo a última ocorrência (assume que a versão mais recente
  // colada é a mais confiável). Sem isso, o INSERT com ON CONFLICT falha
  // porque duas linhas do mesmo lote tentam atualizar a mesma linha.
  const d1ByKey = new Map();
  d1RowsRaw.forEach((r) => {
    const idKey = r.id_da_pessoa_entregadora || ('NOID:' + normName(r.pessoa_entregadora));
    const key = [r.data_do_periodo, r.periodo, idKey, r.sub_praca || ''].join('|');
    d1ByKey.set(key, r);
  });
  const d1Rows = Array.from(d1ByKey.values());
  console.log(`D-1: ${d1RowsRaw.length} linhas na planilha, ${d1Rows.length} após dedupe.`);

  const entregadoresByCpf = new Map();
  (dash.posVendas || []).forEach((r) => {
    const cpf = padDigits11(r.cpf);
    if (!cpf) return;
    entregadoresByCpf.set(cpf, {
      cpf,
      nome: r.pessoa_entregadora,
      telefone: String(r.telefone || '').replace(/\D/g, '') || null,
      data_aprovacao: toIsoDate(r.data_aprovacao) || null,
    });
  });
  const entregadoresRows = Array.from(entregadoresByCpf.values());

  const semCorridasRows = (dash.semCorridas || []).map((r) => {
    const cpf = padDigits11(r.CPF);
    if (!cpf) return null;
    return {
      cpf,
      nome: r.Nome,
      telefone: String(r.Telefone || '').replace(/\D/g, '') || null,
      praca: r.Praca || null,
      aprovado_em: toIsoDate(r.Aprovado_em) || null,
      corridas: 0,
    };
  }).filter(Boolean);

  console.log(`D-1: ${d1Rows.length} linhas | Entregadores: ${entregadoresRows.length} | Sem Corridas: ${semCorridasRows.length}`);

  await upsert('d1_rows', d1Rows, 'data_do_periodo,periodo,id_da_pessoa_entregadora,sub_praca');
  await upsert('entregadores', entregadoresRows, 'cpf');
  await upsert('sem_corridas', semCorridasRows, 'cpf');

  console.log('Backfill concluído.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
