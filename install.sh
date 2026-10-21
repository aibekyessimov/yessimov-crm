#!/usr/bin/env bash
# Установка YESSIMOV CRM на сервер Ubuntu. Запуск: curl -fsSL <адрес>/install.sh | bash
set -e
echo "== YESSIMOV CRM: установка =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y nodejs git curl >/dev/null
APP=/opt/yessimov-crm
if [ -d "$APP/.git" ]; then git -C "$APP" pull -q; else git clone -q https://github.com/aibekyessimov/yessimov-crm "$APP"; fi
ENVF=/etc/yessimov-crm.env
mkdir -p /var/lib/yessimov-crm
if [ ! -f "$ENVF" ]; then
  gen() { tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' </dev/urandom | head -c "$1"; }
  cat > "$ENVF" <<CONF
PORT=8080
DATA_DIR=/var/lib/yessimov-crm
SESSION_SECRET=$(gen 32)
ADMIN_PASS=$(gen 10)
SELLER_PASS=$(gen 8)
CONF
  chmod 600 "$ENVF"
fi
cat > /etc/systemd/system/yessimov-crm.service <<UNIT
[Unit]
Description=YESSIMOV CRM
After=network-online.target
[Service]
EnvironmentFile=$ENVF
ExecStart=/usr/bin/node $APP/server.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/yessimov-crm-update.service <<UNIT
[Unit]
Description=YESSIMOV CRM auto-update
[Service]
Type=oneshot
ExecStart=/bin/bash $APP/update.sh
UNIT
cat > /etc/systemd/system/yessimov-crm-update.timer <<UNIT
[Unit]
Description=YESSIMOV CRM auto-update every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now yessimov-crm >/dev/null 2>&1
systemctl restart yessimov-crm
systemctl enable --now yessimov-crm-update.timer >/dev/null 2>&1
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 8080/tcp >/dev/null; fi
sleep 2
IP=$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
. "$ENVF"
echo
echo "======================================================"
echo " YESSIMOV CRM установлена и работает"
echo " Адрес:           http://$IP:8080"
echo " Пароль админа:   $ADMIN_PASS"
echo " Пароль продавца: $SELLER_PASS"
echo "======================================================"
echo " Показать пароли снова: cat /etc/yessimov-crm.env"
