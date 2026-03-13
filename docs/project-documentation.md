# Patchbook — Documentazione di Progetto

## Panoramica

**Patchbook** è un linguaggio di markup e un parser per scrivere e distribuire patch di sintetizzatori modulari, creato da [Spektro Audio](http://spektroaudio.com/).

Il linguaggio di markup è progettato per essere facilmente leggibile e scrivibile da esseri umani, mentre il parser elabora file `.txt` scritti nel formato Patchbook e produce output strutturati (JSON, GraphViz DOT) utilizzabili da altre applicazioni.

- **Versione Patchbook:** 1.2
- **Versione Parser:** b3
- **Licenza:** MIT (Copyright © 2017 Spektro Audio)
- **Linguaggio:** Python 3

---

## Struttura del Repository

```
Patchbook/
├── patchbook.py          # Parser principale
├── README.md             # Documentazione utente e markup reference
├── LICENSE               # Licenza MIT
├── Examples/
│   ├── patch1.txt        # Esempio: singola voce con Metropolis/Braids
│   ├── patch2.txt        # Esempio: due voci con connessioni multiple
│   └── syncpll.txt       # Esempio: patch con PLL e mixing complesso
├── Images/
│   └── patchbook-logo.jpg
└── docs/
    └── project-documentation.md
```

---

## Architettura del Parser (`patchbook.py`)

### Dipendenze

Il parser utilizza esclusivamente moduli della libreria standard Python:

| Modulo     | Utilizzo                              |
|------------|---------------------------------------|
| `sys`      | Accesso ai parametri di sistema       |
| `re`       | Espressioni regolari per il parsing   |
| `os`       | Gestione percorsi file                |
| `argparse` | Parsing degli argomenti CLI           |
| `json`     | Esportazione dati in formato JSON     |

### Struttura Dati Principale

Il parser mantiene un dizionario globale `mainDict` con la seguente struttura:

```json
{
  "info": {
    "patchbook_version": "b3"
  },
  "modules": {
    "<nome_modulo>": {
      "parameters": {
        "<nome_parametro>": "<valore>"
      },
      "connections": {
        "out": {
          "<porta_output>": [
            {
              "input_module": "<modulo_destinazione>",
              "input_port": "<porta_destinazione>",
              "connection_type": "<tipo>",
              "voice": "<voce>",
              "id": "<id_connessione>"
            }
          ]
        },
        "in": {
          "<porta_input>": {
            "output_module": "<modulo_sorgente>",
            "output_port": "<porta_sorgente>",
            "connection_type": "<tipo>",
            "voice": "<voce>",
            "id": "<id_connessione>"
          }
        }
      }
    }
  },
  "comments": ["<commento_1>", "<commento_2>"]
}
```

### Tipi di Connessione

| Simbolo | Tipo       | Descrizione                     |
|---------|------------|---------------------------------|
| `->`    | `audio`    | Segnale audio                   |
| `>>`    | `cv`       | Control Voltage generico        |
| `p>`    | `pitch`    | Pitch (1V/oct o Hz/V)          |
| `g>`    | `gate`     | Segnale gate                    |
| `t>`    | `trigger`  | Segnale trigger                 |
| `c>`    | `clock`    | Segnale clock                   |

---

## Funzioni Principali

### Parsing

| Funzione             | Descrizione                                                                                       |
|----------------------|---------------------------------------------------------------------------------------------------|
| `parseFile(filename)` | Legge il file `.txt` riga per riga e invoca `regexLine()` per ciascuna riga.                     |
| `regexLine(line)`     | Analizza ogni riga tramite regex per identificare commenti, voci, connessioni o parametri.        |
| `parseArguments(args)` | Converte stringhe di argomenti extra (es. `[color=red]`) in dizionario.                          |

### Gestione Dati

| Funzione                                        | Descrizione                                                             |
|-------------------------------------------------|-------------------------------------------------------------------------|
| `addConnection(list, voice)`                     | Aggiunge una connessione (output → input) al dizionario principale.     |
| `checkModuleExistance(module, port, direction)` | Verifica l'esistenza di un modulo nel dizionario; lo crea se mancante.  |
| `addParameter(module, name, value)`              | Aggiunge un parametro a un modulo specifico.                            |
| `addComment(value)`                              | Aggiunge un commento alla lista dei commenti.                           |

### Output e Visualizzazione

| Funzione             | Descrizione                                                                                     |
|----------------------|-------------------------------------------------------------------------------------------------|
| `askCommand()`        | Loop interattivo per la selezione dei comandi utente.                                           |
| `detailModule(all)`   | Mostra i dettagli (input, output, parametri) di uno o di tutti i moduli.                        |
| `printConnections()`  | Stampa tutte le connessioni raggruppate per tipo di segnale.                                    |
| `exportJSON()`        | Esporta `mainDict` in formato JSON su stdout.                                                   |
| `graphviz()`          | Genera codice DOT per GraphViz con rappresentazione grafica del signal flow.                    |
| `printDict()`         | Stampa il dizionario dei moduli in formato raw.                                                 |

### Utility

| Funzione           | Descrizione                                    |
|--------------------|------------------------------------------------|
| `initial_print()`  | Stampa il banner iniziale con versione.        |
| `get_script_path()` | Restituisce il path della directory dello script. |
| `getFilePath(filename)` | Costruisce il path completo del file.      |

---

## Interfaccia da Linea di Comando (CLI)

```bash
python3 patchbook.py -file <percorso_file.txt> [opzioni]
```

### Argomenti

| Flag           | Tipo   | Default | Descrizione                                               |
|----------------|--------|---------|-----------------------------------------------------------|
| `-file`        | `str`  | `""`    | Percorso del file `.txt` da parsare                       |
| `-debug`       | `int`  | `0`     | Abilita la modalità debug (`1` = attivo)                  |
| `-dir`         | `str`  | `LR`   | Direzione del grafo: `LR` (sinistra→destra) o `DN` (alto→basso) |
| `-modules`     | flag   | —       | Stampa tutti i moduli ed esce                             |
| `-print`       | flag   | —       | Stampa la struttura dati ed esce                          |
| `-export`      | flag   | —       | Stampa JSON ed esce                                       |
| `-connections` | flag   | —       | Stampa tutte le connessioni ed esce                       |
| `-graph`       | flag   | —       | Stampa codice DOT per GraphViz ed esce                    |

### Comandi Interattivi

Quando nessun flag one-shot è specificato, il parser entra in modalità interattiva con i seguenti comandi:

- `module` — Mostra dettagli di un singolo modulo (richiede input del nome)
- `modules` — Mostra dettagli di tutti i moduli
- `print` — Stampa la struttura dati completa
- `export` — Esporta in JSON
- `connections` — Stampa tutte le connessioni per tipo
- `graph` — Genera codice DOT per GraphViz

---

## Generazione Grafica con GraphViz

Il comando `graph` produce codice DOT compatibile con [GraphViz](https://graphviz.org/). Il grafo rappresenta il signal flow della patch con:

- **Nodi** (moduli): box con porte di input/output e parametri
- **Archi** (connessioni): linee stilizzate per tipo di segnale

### Stili delle Connessioni nel Grafo

| Tipo       | Colore   | Stile     |
|------------|----------|-----------|
| `audio`    | default  | `bold`    |
| `cv`       | gray     | default   |
| `gate`     | red      | `dashed`  |
| `trigger`  | orange   | `dashed`  |
| `pitch`    | blue     | default   |
| `clock`    | purple   | `dashed`  |

Le connessioni supportano anche argomenti GraphViz aggiuntivi (`color`, `weight`, `style`, `arrowtail`, `dir`) specificati inline nel file di patch.

---

## Linguaggio di Markup Patchbook

### Voci (Voices)

Dichiarate in maiuscolo seguite da due punti. Ogni connessione successiva viene assegnata alla voce corrente.

```
VOICE 1:
BASS:
LEAD:
```

### Connessioni

Formato: `- Modulo Output (Porta) <tipo> Modulo Input (Porta) [argomenti opzionali]`

```
- Braids (Out) -> Polaris (Input)
- Metropolis (Pitch) p> Braids (1 V/Oct)
- Metropolis (Gate) g> Function (Trigger) [color=red, weight=3]
```

### Parametri

**Single-line:**
```
* Function: Rise = 50% | Fall = 50% | Curve = 30%
```

**Multi-line:**
```
* Braids:
	| Mode = CSAW
	| Color = 50%
	| Timbre = 50%
```

### Commenti

```
// Questo è un commento
```

---

## Flusso di Esecuzione

```
main
 ├── initial_print()          # Banner
 ├── parseFile(filename)      # Lettura e parsing del file
 │    └── regexLine(line)     # Per ogni riga:
 │         ├── Check commenti (// ...)
 │         ├── Check voci (NOME:)
 │         ├── Check connessioni (- Mod (port) >> Mod (port))
 │         └── Check parametri (* Modulo: param = val)
 └── askCommand()             # Loop interattivo o one-shot command
      ├── module / modules
      ├── print
      ├── export (JSON)
      ├── connections
      └── graph (DOT)
```

---

## Esempi di Utilizzo

### Parsing e export JSON
```bash
python3 patchbook.py -file Examples/patch1.txt -export
```

### Generazione grafo DOT
```bash
python3 patchbook.py -file Examples/syncpll.txt -graph
```

### Visualizzazione moduli
```bash
python3 patchbook.py -file Examples/patch2.txt -modules
```

### Modalità interattiva
```bash
python3 patchbook.py -file Examples/patch1.txt
```

---

## Note Tecniche

- Il parser utilizza variabili globali (`lastModuleProcessed`, `lastVoiceProcessed`) per tracciare il contesto durante il parsing sequenziale delle righe.
- Le porte di input in `mainDict` memorizzano un singolo dizionario (ultima connessione), mentre le porte di output memorizzano una lista (connessioni multiple possibili).
- L'ID delle connessioni (`connectionID`) è un contatore globale incrementale usato per collegare le entry in/out corrispondenti.
- La funzione `graphviz()` restituisce anche la stringa DOT completa come valore di ritorno, oltre a stamparla su stdout.
