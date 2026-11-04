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
