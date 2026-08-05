"""Script de correção: remove linhas duplicadas da d1_rows.

O bug: PostgreSQL não considera NULL=NULL em constraints UNIQUE padrão,
então upserts com sub_praca=NULL criavam múltiplas linhas se o d1_sync
rodasse mais de uma vez para o mesmo dia.

Execução: python -m robots.fix_d1_duplicates
"""
import os
import requests
from dotenv import load_dotenv

load_dotenv()

URL = os.environ["SUPABASE_URL"].strip()
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"].strip()
HEADERS = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
}
PAGE = 1000


def fetch_all(endpoint):
    rows = []
    offset = 0
    while True:
        r = requests.get(
            f"{URL}/rest/v1/{endpoint}",
            headers={**HEADERS, "Range": f"{offset}-{offset + PAGE - 1}"},
            timeout=30,
        )
        r.raise_for_status()
        chunk = r.json()
        rows += chunk
        if len(chunk) < PAGE:
            break
        offset += PAGE
        print(f"  ... {len(rows)} linhas carregadas", end="\r")
    return rows


def main():
    print("=== 1. Carregando d1_rows (pode demorar) ===")
    rows = fetch_all("d1_rows?select=id,data_do_periodo,periodo,id_da_pessoa_entregadora,sub_praca,pessoa_entregadora&order=id.asc")
    print(f"\nTotal de linhas: {len(rows)}")

    print("\n=== 2. Identificando duplicatas ===")
    seen = {}   # chave → menor id (que vamos manter)
    ids_deletar = []
    for r in rows:
        chave = (
            r["data_do_periodo"],
            r["periodo"],
            r["id_da_pessoa_entregadora"] or "",
            r["sub_praca"] or "",
        )
        rid = r["id"]
        if chave in seen:
            ids_deletar.append(rid)  # id maior = duplicata, apaga
        else:
            seen[chave] = rid

    print(f"Linhas duplicadas a remover: {len(ids_deletar)}")
    if not ids_deletar:
        print("Nenhuma duplicata encontrada. Banco já está limpo.")
        return

    # Mostra amostra
    amostra_ids = ids_deletar[:5]
    amostra = [r for r in rows if r["id"] in amostra_ids]
    for r in amostra:
        print(f"  id={r['id']} | {r['data_do_periodo']} | {r['periodo'][:25]} | {r['pessoa_entregadora'][:25]}")

    confirm = input(f"\nRemover {len(ids_deletar)} linhas? (s/N): ").strip().lower()
    if confirm != "s":
        print("Cancelado.")
        return

    print("\n=== 3. Deletando em lotes de 500 ===")
    CHUNK = 500
    deletados = 0
    for i in range(0, len(ids_deletar), CHUNK):
        lote = ids_deletar[i:i + CHUNK]
        ids_str = ",".join(str(x) for x in lote)
        r = requests.delete(
            f"{URL}/rest/v1/d1_rows?id=in.({ids_str})",
            headers={**HEADERS, "Prefer": "return=minimal"},
            timeout=30,
        )
        if not r.ok:
            print(f"  ERRO no lote {i}: {r.status_code} {r.text}")
        else:
            deletados += len(lote)
            print(f"  {deletados}/{len(ids_deletar)} removidos...")

    print(f"\nConcluído: {deletados} linhas duplicadas removidas.")

    print("\n=== 4. Verificando Rhodrygo pós-correção ===")
    rhodrygo = fetch_all(
        "d1_rows?pessoa_entregadora=ilike.*rhodrygo*"
        "&data_do_periodo=gte.2026-08-03&data_do_periodo=lte.2026-08-09"
        "&select=data_do_periodo,periodo,numero_de_pedidos_aceitos_e_concluidos"
        "&order=data_do_periodo,periodo"
    )
    total = sum(float(r["numero_de_pedidos_aceitos_e_concluidos"] or 0) for r in rhodrygo)
    for r in rhodrygo:
        print(f"  {r['data_do_periodo']} | {r['periodo'][:25]} | pedidos={r['numero_de_pedidos_aceitos_e_concluidos']}")
    print(f"  TOTAL semana: {total:.0f} pedidos")


if __name__ == "__main__":
    main()
