# YESSIMOV CRM

Своя CRM бутика YESSIMOV: остатки по моделям (цвет × размер), приходы, движение товара,
решения по лестнице уценки и повторам, Telegram-бот со сводками. Касса остаётся в BILLZ —
CRM каждый час забирает данные через API BILLZ.

В репозитории только код: ключи, пароли и данные магазина хранятся на сервере
(`/etc/yessimov-crm.env`, `/var/lib/yessimov-crm`) и сюда не попадают.

Установка на Ubuntu: `curl -fsSL https://raw.githubusercontent.com/aibekyessimov/yessimov-crm/main/install.sh | bash`
