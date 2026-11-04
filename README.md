# Promemoria farmaci

Web app per ricordare i farmaci di tutta la famiglia: un solo file HTML, nessun server e nessuna registrazione.

## Cosa fa

- **Profili per la famiglia**: ognuno con i propri farmaci, orari e storico.
- **Oggi**: le dosi del giorno divise in mattina, pomeriggio e sera, con i pulsanti "Preso" e "Salta".
- **Promemoria**: un avviso nella pagina con suono e, se il browser lo consente, una notifica. Puoi farti ricordare la dose più tardi.
- **Scorte**: il conteggio delle compresse scende a ogni dose e ti avvisa quando stanno per finire.
- **Storico**: l'andamento degli ultimi 7 giorni e il dettaglio degli ultimi 14.

## Dove sono i dati

Tutti i dati restano **nel browser del dispositivo** (localStorage) e non vengono inviati a nessun server. Se cancelli i dati di navigazione, li perdi. Ogni telefono o browser ha i propri dati.

## Limiti

I promemoria funzionano solo **mentre la pagina è aperta**. Con il telefono bloccato o il browser chiuso non arrivano: per le dosi importanti imposta anche una sveglia sul telefono.

L'app aiuta a ricordare, ma non sostituisce le indicazioni del medico o del farmacista.

## Pubblicazione

Il sito è servito con GitHub Pages dal file `index.html` sul branch `main`.

---

# Bot Telegram

La cartella `bot/` contiene un bot Telegram che manda i promemoria **anche con il telefono bloccato**, con i pulsanti ✅ Preso, ⏰ 10 min e ⏭ Salta. Gira gratis su Cloudflare Workers e viene pubblicato in automatico da GitHub Actions a ogni modifica.

## Configurazione (una volta sola)

1. **Crea il bot**: in Telegram scrivi a `@BotFather`, invia `/newbot`, scegli un nome e un username che finisca in `bot`. Copia il **token** che ti dà.
2. **Cloudflare**: crea un account gratuito su cloudflare.com e apri una volta **Workers & Pages** (serve ad attivare il sottodominio `workers.dev`).
   - Copia l'**Account ID** (pagina Workers & Pages o pagina iniziale dell'account).
   - Crea un **API token**: Profilo → API Tokens → Create Token → modello **"Edit Cloudflare Workers"**.
3. **GitHub**: nel repository vai su Settings → Secrets and variables → Actions → New repository secret e crea:
   - `TELEGRAM_BOT_TOKEN`
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. Vai su **Actions → Pubblica bot Telegram → Run workflow**.
5. Scrivi `/start` al tuo bot: chi lo fa per primo diventa amministratore e approva gli altri familiari.

## Comandi

`/aggiungi` · `/oggi` · `/farmaci` · `/scorte` · `/storico` · `/annulla` · `/aiuto`

Il bot si può aggiungere anche a un gruppo di famiglia: ogni chat ha il proprio elenco di farmaci.

## Privacy

Nomi, farmaci e orari sono salvati nel tuo account Cloudflare (Durable Object) e passano da Telegram. Lo storico viene cancellato dopo 90 giorni.
