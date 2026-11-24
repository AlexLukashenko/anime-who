# Сквозной тест

Поддельные YummyAnime / Kodik / Shikimori / AniList / Jimaku на локальном HTTPS и синтетическая «серия»:
русская речь (espeak-ng) по таймингам субтитров со сдвигом 17.3 с, музыка и шум.

```
python3 make_audio.py          # нужны espeak-ng, ffmpeg, numpy → .out/
cd .out && openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj "/CN=mock" && cd ..
sudo node server.mjs &          # слушает 443
node run.mjs                    # Kodik: задержка, автоподбор, поля баннера, перемотка (нужен playwright с Chromium)
node run-sites.mjs              # CVH (вложенный плеер), сайт в стиле DreamCast, ручной выбор аниме и серии
```

Ожидаемо: сдвиг 17.3 с найден по звуку примерно за 40 с просмотра, баннеры совпадают с упоминаниями,
после перезагрузки сдвиг берётся из сохранённого. Скриншоты — в `.out/`.
