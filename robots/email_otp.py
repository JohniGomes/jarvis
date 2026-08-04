"""Le o codigo de verificacao (OTP) mais recente de uma caixa IMAP -- usado
pelo robo de D-1 pra completar o login do franqueado.entregolog.com sem
intervencao manual.
"""
import email
import imaplib
import os
import re
import time
from email.header import decode_header

IMAP_HOST = os.environ.get("EMAIL_IMAP_HOST", "imap.titan.email")
IMAP_PORT = int(os.environ.get("EMAIL_IMAP_PORT", "993"))


def _decode(value):
    if not value:
        return ""
    parts = decode_header(value)
    out = ""
    for text, enc in parts:
        if isinstance(text, bytes):
            out += text.decode(enc or "utf-8", errors="ignore")
        else:
            out += text
    return out


def buscar_ultimo_email(user, password, minutos=5, remetente_contendo=None, assunto_contendo=None):
    """Retorna (assunto, corpo_texto) do email mais recente que casar com os
    filtros, ou None se nao achar nada."""
    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    try:
        conn.login(user, password)
        conn.select("INBOX")
        _typ, data = conn.search(None, "ALL")
        ids = data[0].split()
        ids = ids[-15:] if len(ids) > 15 else ids  # só os mais recentes
        candidatos = []
        for msg_id in reversed(ids):
            _typ, msg_data = conn.fetch(msg_id, "(RFC822)")
            raw = msg_data[0][1]
            msg = email.message_from_bytes(raw)
            assunto = _decode(msg.get("Subject"))
            remetente = _decode(msg.get("From"))
            if remetente_contendo and remetente_contendo.lower() not in remetente.lower():
                continue
            if assunto_contendo and assunto_contendo.lower() not in assunto.lower():
                continue
            corpo = _extrair_corpo(msg)
            candidatos.append((assunto, corpo, remetente))
        return candidatos
    finally:
        conn.logout()


def _extrair_corpo(msg):
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                try:
                    return part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="ignore")
                except Exception:
                    pass
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                try:
                    return part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="ignore")
                except Exception:
                    pass
        return ""
    try:
        return msg.get_payload(decode=True).decode(msg.get_content_charset() or "utf-8", errors="ignore")
    except Exception:
        return str(msg.get_payload())


def extrair_codigo(texto):
    # O e-mail do franqueado.entregolog.com traz o código isolado numa linha
    # própria, sempre com 6 dígitos, antes da linha "O código expira em ...".
    m = re.search(r"(?m)^\s*(\d{6})\s*$", texto)
    if m:
        return m.group(1)
    m = re.search(r"\b(\d{4,8})\b", texto)
    return m.group(1) if m else None


def buscar_codigo_acesso(user, senha_imap, tentativas=6, intervalo_seg=5):
    """Poll a caixa até achar um e-mail de 'Código de acesso' do entregolog e
    devolve o código extraído. Levanta erro se não achar em tempo."""
    for tentativa in range(tentativas):
        candidatos = buscar_ultimo_email(
            user, senha_imap, remetente_contendo="entregolog", assunto_contendo="digo de acesso"
        )
        if candidatos:
            codigo = extrair_codigo(candidatos[0][1])
            if codigo:
                return codigo
        time.sleep(intervalo_seg)
    raise RuntimeError("Não recebi o e-mail com o código de acesso do franqueado.entregolog.com a tempo.")


if __name__ == "__main__":
    user = os.environ["FRANQUEADO_EMAIL"]
    senha_imap = os.environ["EMAIL_IMAP_PASSWORD"]
    candidatos = buscar_ultimo_email(user, senha_imap)
    for assunto, corpo, remetente in candidatos[:8]:
        print("=" * 60)
        print("De:", remetente)
        print("Assunto:", assunto)
        print("Corpo (300 chars):", corpo[:300])
