#!/usr/bin/env bash
# Автообновление: если на GitHub появилась новая версия, скачиваем и перезапускаем CRM.
cd /opt/yessimov-crm || exit 0
git fetch -q origin main || exit 0
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git reset -q --hard origin/main
  systemctl restart yessimov-crm
fi
