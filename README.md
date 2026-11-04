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

La cartella `bot/` contiene un bot Telegram che manda i promemoria **anche con il telefono bloccato**, con i pulsanti ✅ Preso, ⏰ 10 min e ⏭ Salta. Gira gratis su Cloudflare Workers, che lo ripubblica in automatico a ogni modifica del repository.

## Configurazione (una volta sola)

1. **Crea il bot**: in Telegram scrivi a `@BotFather`, invia `/newbot`, scegli un nome e un username che finisca in `bot`. Copia il **token**.
2. **Collega il repository a Cloudflare**: crea un account gratuito su cloudflare.com, poi vai su **Workers & Pages → Create → Import a repository**, collega GitHub e scegli `promemoria-farmaci`.
   - Nome del progetto: `promemoria-farmaci-bot`
   - **Root directory** (in *Advanced settings*): `bot`
   - Lascia il resto com'è e premi **Deploy**.
3. **Inserisci il token**: nel worker appena creato vai su **Settings → Variables and Secrets → Add**, tipo **Secret**, nome `TELEGRAM_BOT_TOKEN`, valore il token del punto 1, poi **Deploy**.
4. **Collega Telegram**: apri nel browser `https://promemoria-farmaci-bot.<tuo-sottodominio>.workers.dev/setup` (l'indirizzo esatto è nella pagina del worker). Deve comparire `"ok":true`.
5. Scrivi `/start` al tuo bot: da quel momento il bot è **solo tuo** e risponde soltanto a te.

## Comandi

`/aggiungi` · `/oggi` · `/farmaci` · `/scorte` · `/storico` · `/terapia` · `/esporta` · `/trasferisci` · `/annulla` · `/aiuto`

Puoi gestire anche i farmaci dei familiari: quando aggiungi un farmaco scegli per chi è.

**Condividere con la famiglia**: crea un gruppo Telegram, aggiungi il bot e scrivi `/start` nel gruppo (deve farlo chi ha creato il bot). Nel gruppo tutti possono aggiungere farmaci e segnare le dosi; i promemoria arrivano lì. Con `/trasferisci` sposti nel gruppo i farmaci di una persona dalla chat privata.

## Privacy

Nomi, farmaci e orari sono salvati nel tuo account Cloudflare (Durable Object) e passano da Telegram. Lo storico viene cancellato dopo 90 giorni.
