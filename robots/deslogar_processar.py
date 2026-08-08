"""Processa pedidos de "me desloga do turno" (deslogar_status) -- disparado
por webhook (repository_dispatch) sempre que a Edge Function
chatwoot-troca-praca grava um pedido pendente, com um cron de segurança
a cada 10 min como rede de segurança (ver .github/workflows/deslogar-dispatch.yml).

Fluxo (descrito pelo usuário em 06/08/2026, confirmado por exploração
manual da página):
  1. Login em franqueado.entregolog.com
  2. Vai em /supply/logistic-operator/shift-schedule (Gestor de Escalas)
  3. Abre Filtros, busca por CPF, aplica
  4. Acha, entre as escalas retornadas, a que está "em andamento" agora
     (data de hoje + horário atual dentro do intervalo do turno) -- só
     mexe nessa, nunca em turnos futuros
  5. Clica na seta ("Ver detalhes da escala") -> Prosseguir -> acha a
     linha da pessoa (data-testid="schedule-status-row") -> clica na
     lixeira -> confirma "Excluir"
  6. Sucesso -> responde na conversa do Chatwoot com uma variação de
     "Opaa, feito" (personalidade definida pelo usuário). Falha -> fica
     em silêncio (mesma filosofia do chatwoot-troca-praca: quem não tem
     certeza não fala nada, time humano assume).

Uso: python -m robots.deslogar_processar
"""
import os
import re
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from robots.browser_launch import launch_browser
from robots.franqueado_login import login as franqueado_login

load_dotenv()

MAX_TENTATIVAS = 4
SHIFT_SCHEDULE_URL = "https://franqueado.entregolog.com/supply/logistic-operator/shift-schedule"

# O robô roda no GitHub Actions (UTC) -- datetime.now() sem fuso comparava
# errado contra os horários dos turnos (que são sempre em horário de
# Brasília). Sempre usar agora_brasilia() pra decidir "turno em andamento".
BRASILIA_TZ = ZoneInfo("America/Sao_Paulo")


def agora_brasilia():
    return datetime.now(BRASILIA_TZ)

CHATWOOT_BASE_URL = "https://chatwoot.rayo-ia.com.br"
CHATWOOT_ACCOUNT_ID = 2

RESPOSTAS_SUCESSO = ["Feito.", "Opaa, feito!", "Show, feito!", "Belezinha, feito!", "Faala mano! Feito."]


def log(msg):
    print(f"[{agora_brasilia().strftime('%H:%M:%S')}] {msg}", flush=True)


def _supa_headers():
    url = os.environ["SUPABASE_URL"].strip()
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"].strip()
    return url, {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def buscar_pendentes(url, headers):
    r = requests.get(
        f"{url}/rest/v1/deslogar_status?pendente=is.true&select=cpf,nome,conversation_id",
        headers=headers, timeout=15,
    )
    r.raise_for_status()
    return r.json()


def marcar_concluido(url, headers, cpf, status):
    requests.patch(
        f"{url}/rest/v1/deslogar_status?cpf=eq.{cpf}",
        headers={**headers, "Prefer": "return=minimal"},
        json={"pendente": False, "status": status, "erro_msg": None},
        timeout=15,
    )


def marcar_erro(url, headers, cpf, msg):
    requests.patch(
        f"{url}/rest/v1/deslogar_status?cpf=eq.{cpf}",
        headers={**headers, "Prefer": "return=minimal"},
        json={"pendente": False, "status": "erro", "erro_msg": msg[:500]},
        timeout=15,
    )


def responder_chatwoot(conversation_id, content):
    token = os.environ["CHATWOOT_TOKEN"].strip()
    base = f"{CHATWOOT_BASE_URL}/api/v1/accounts/{CHATWOOT_ACCOUNT_ID}"
    resp = requests.post(
        f"{base}/conversations/{conversation_id}/messages",
        headers={"api_access_token": token, "Content-Type": "application/json"},
        json={"content": content, "message_type": "outgoing"},
        timeout=15,
    )
    resp.raise_for_status()


def resposta_sucesso():
    import random
    return random.choice(RESPOSTAS_SUCESSO)


# "ALMOCO 11H30-15H29" -> (time(11,30), time(15,29))
_TURNO_HORARIO_RE = re.compile(r"(\d{1,2})H(\d{2})-(\d{1,2})H(\d{2})", re.IGNORECASE)
_DATA_RE = re.compile(r"(\d{2}/\d{2}/\d{4})")


def _turno_em_andamento(texto_linha, agora):
    """texto_linha: texto bruto da linha inteira da tabela (todas as
    células juntas). Playwright separa células irmãs com TAB, não quebra
    de linha -- por isso busca a data e o horário via regex no texto
    inteiro, em vez de tentar dividir a linha em "colunas" por \\n (bug
    encontrado em teste real 07/08/2026: dava sempre False)."""
    m_data = _DATA_RE.search(texto_linha)
    if not m_data:
        return False
    try:
        data_turno = datetime.strptime(m_data.group(1), "%d/%m/%Y").date()
    except ValueError:
        return False
    if data_turno != agora.date():
        return False
    m = _TURNO_HORARIO_RE.search(texto_linha)
    if not m:
        return False
    h_ini, m_ini, h_fim, m_fim = (int(x) for x in m.groups())
    minutos_agora = agora.hour * 60 + agora.minute
    minutos_ini = h_ini * 60 + m_ini
    minutos_fim = h_fim * 60 + m_fim
    return minutos_ini <= minutos_agora <= minutos_fim


def processar_um(page, cpf, nome):
    """Retorna True se removeu com sucesso, False se não achou turno em
    andamento (não é erro -- só não tem o que deslogar agora)."""
    page.goto(SHIFT_SCHEDULE_URL)
    page.get_by_role("button", name=re.compile("^Filtros", re.I)).first.click()
    campo_cpf = page.get_by_placeholder("Buscar por CPF")
    campo_cpf.wait_for(timeout=20000)
    campo_cpf.fill(cpf)
    page.get_by_role("button", name="Aplicar filtros").click()
    page.wait_for_timeout(1500)

    linhas = page.locator("table tbody tr")
    total = linhas.count()
    log(f"{total} escala(s) encontrada(s) pro CPF {cpf}.")

    agora = agora_brasilia()
    linha_alvo = None
    for i in range(total):
        linha = linhas.nth(i)
        texto = linha.inner_text()
        if _turno_em_andamento(texto, agora):
            linha_alvo = linha
            log(f"Turno em andamento encontrado: {texto.splitlines()[0][:60]}")
            break

    if linha_alvo is None:
        log("Nenhum turno em andamento agora pra esse CPF.")
        return False

    linha_alvo.get_by_role("button", name="Ver detalhes da escala").click()
    page.get_by_role("button", name="Prosseguir").click()

    cpf_formatado = f"{cpf[:3]}.{cpf[3:6]}.{cpf[6:9]}-{cpf[9:11]}"
    linha_pessoa = page.locator('[data-testid="schedule-status-row"]', has_text=cpf_formatado).first
    linha_pessoa.wait_for(timeout=15000)
    linha_pessoa.locator("button").click()

    page.get_by_role("button", name="Excluir", exact=True).click()
    page.wait_for_timeout(1500)
    log(f"Removido do turno em andamento: {nome} ({cpf}).")
    return True


def _login_com_retry(p):
    ultimo_erro = None
    for tentativa in range(1, MAX_TENTATIVAS + 1):
        browser = launch_browser(p.chromium)
        page = browser.new_page(accept_downloads=True)
        try:
            franqueado_login(page)
            return browser, page
        except Exception as e:
            ultimo_erro = e
            log(f"Tentativa {tentativa}/{MAX_TENTATIVAS} de login falhou: {type(e).__name__}: {e}")
            try:
                page.screenshot(path=f"robots/debug_deslogar_tentativa{tentativa}.png", full_page=True, timeout=5000)
            except Exception:
                pass
            browser.close()
            if tentativa < MAX_TENTATIVAS:
                time.sleep(8)
    raise ultimo_erro


HORARIO_INICIO_MIN = 6 * 60  # 06:00
HORARIO_FIM_MIN = 15 * 60 + 30  # 15:30


def dentro_do_horario_de_operacao():
    agora = agora_brasilia()
    minutos = agora.hour * 60 + agora.minute
    return HORARIO_INICIO_MIN <= minutos < HORARIO_FIM_MIN


def main():
    # Segunda camada de proteção -- a Edge Function chatwoot-troca-praca já
    # não grava pedido fora do horário de operação, mas se algo passar
    # (ex.: teste manual, bug futuro), esse robô não deve agir de qualquer
    # jeito só porque tem um pendente na fila. Descoberto na prática
    # 08/08/2026: um teste que ignorou a checagem da function acabou
    # disparando pedidos de verdade às 2h da manhã.
    if not dentro_do_horario_de_operacao():
        log("Fora do horário de operação (06:00-15:30) -- não processa agora, fica pra próxima checagem.")
        return

    url, headers = _supa_headers()
    pendentes = buscar_pendentes(url, headers)
    if not pendentes:
        log("Nenhum pedido de deslogar pendente.")
        return

    with sync_playwright() as p:
        log("Login em franqueado.entregolog.com...")
        browser, page = _login_com_retry(p)
        try:
            for p_item in pendentes:
                cpf, nome, conversation_id = p_item["cpf"], p_item["nome"], p_item["conversation_id"]
                try:
                    sucesso = processar_um(page, cpf, nome)
                    if sucesso:
                        marcar_concluido(url, headers, cpf, "deslogado")
                        responder_chatwoot(conversation_id, resposta_sucesso())
                    else:
                        marcar_erro(url, headers, cpf, "Nenhum turno em andamento encontrado.")
                except Exception as e:
                    erro_msg = f"{type(e).__name__}: {e}"
                    log(f"ERRO processando {cpf}: {erro_msg}")
                    try:
                        page.screenshot(path="robots/debug_deslogar_processar.png", full_page=True, timeout=5000)
                    except Exception:
                        pass
                    marcar_erro(url, headers, cpf, erro_msg)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
