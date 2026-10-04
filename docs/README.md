# Lampa kinopub plugin

Плагин-источник видео [kinopub](https://kino.pub) для медиацентра [Lampa](https://github.com/yumata/lampa). Ориентирован на Samsung Tizen (Tizen TV), работает также на webOS, Android и в браузере.

## Установка

Прямая ссылка плагина:

```
https://aomikh.github.io/lampa_kinopub/kp.js
```

В Lampa: Настройки → Расширения → Добавить плагин → вставить URL → Сохранить.

## Авторизация

При первом запуске плагин показывает Device Flow код kinopub — открыть [kino.pub/device](https://kino.pub/device) на телефоне или ПК, ввести код, и плагин автоматически продолжит работу.

## Настройки

`Настройки → KinoPub`:

| Поле                | Назначение |
|---------------------|------------|
| URL лог-сервера     | Адрес [log-server](./log-server/) для удалённых логов с ТВ |
| Макс. качество      | Верхняя граница потока |
| Формат потока       | http / hls / hls2 / hls4 / авто |
| CORS-прокси         | Опционально, на Tizen не нужен |
| Авторизоваться      | Открыть окно с кодом для kino.pub/device |
| Выйти из аккаунта   | Удалить токены |

## Лог-сервер

`log-server/` — мини Node.js сервер для приёма JSON-логов от плагина. См. [log-server/README.md](./log-server/README.md).

## Структура

```
.
├─ docs/        # содержимое GitHub Pages (kp.js, index.html)
│  └─ kp.js       # сам плагин
├─ log-server/    # мини HTTP сервер для удалённого логирования
└─ filmix.js      # рабочий пример другого источника (для сверки API Lampa)
```

## Лицензия

MIT (плагин). Плагин не аффилирован с kinopub. Используется публичный xbmc-клиент Device Flow OAuth, известный сообществу неофициальных клиентов.

## Рабочая редакция 1.0.73-mx.2

Эта отдельная редакция добавляет прямые файловые ресурсы для Infuse 8.4.7 и новее, учитывает разовый выбор плеера и сохраняет изображения эпизодов KinoPub. Исходный проект: https://github.com/mainsync-afk/lampa_kinopub. Исправленная версия опубликована из собственного ответвления `aomikh/lampa_kinopub`; на Apple TV воспроизведение не проверено.

Порядок установки и отката: [INSTALL_LAMPA_MX.md](https://github.com/aomikh/lampa_kinopub/blob/main/INSTALL_LAMPA_MX.md). Диагностика, ограничения и проверки: [HANDOFF_LAMPA_MX_KINOPUB.md](https://github.com/aomikh/lampa_kinopub/blob/main/HANDOFF_LAMPA_MX_KINOPUB.md). Данные аккаунта и конфигурация Shadowrocket не изменяются. Проверки: `node --test tests/*.test.cjs` и `node smoke-test.js` из корня рабочей копии.
