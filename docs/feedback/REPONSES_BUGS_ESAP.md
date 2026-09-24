# Réponses aux quatre bugs du template esap

Réponse à la revue de `profiles/esap.workspace.json`, point par point. Écrit
après avoir chargé le fichier, vérifié la vraie liste des crates dans
`Cargo.toml`, et lancé le tout contre la vraie API.

**Les quatre sont confirmés, et les quatre sont réglés.** Deux autres ont été
trouvés en corrigeant, et `every_command` a produit quelque chose de plus général
que ce qu'il réparait.

Une chose à lire en premier, parce que c'est la preuve que le dessin tient plutôt
qu'une opinion dessus : **ton propre `F:\vsCode\EmilsSuperAppPlanner\.dsh\` était
déjà correct sur les quatre points.** Tu n'as pas eu besoin que le harness change
— tu as configuré le projet. C'est exactement ce que la couche workspace existe
pour permettre, et `profiles/esap.workspace.json` est maintenant la copie de ton
`.dsh/` plutôt que l'inverse.

---

## 1. `run_test` produisait une commande invalide — **confirmé, fait**

Trois choses dans un seul point, toutes justes.

**Le `-p crate:test`.** `cargo test -p emils-planner-core:comments` n'est pas du
cargo. Le format `crate:test` est une convention de `cargo-nextest`, pas de
`cargo`. Corrigé en deux arguments séparés, comme tu le proposes :

```json
"run": ["cargo", "test", "-p", "{crate}", "--test", "{test}"]
```

**`emils-planner-wire` n'existe pas.** Vérifié contre `Cargo.toml` : les membres
sont `emils-planner-avoid`, `-cli`, `-core`, `-fonts`, `-harness`, `-icons`,
`-scene`, plus `src-tauri` (qui est `emils-planner-app`) et `xtask`. Le nom
`wire` venait de `crates/emils-planner-scene/tests/wire.rs`, qui est un fichier de
test et non une crate.

**La liste fixe.** C'était le vrai problème du point, et il a fallu une
mécanique : un task file peut maintenant **restreindre** les arguments d'une
commande que le workspace a déclarée.

```json
"commands": { "run_test": { "args": { "crate": { "values": ["emils-planner-core"] } } } }
```

Ce que ce n'est **pas** : le task file ne peut pas toucher au `run`. Seulement aux
arguments. Tout ce qui est dangereux est dans l'argv — c'est là que vit la
validation, parce que c'est un modèle qui choisit les valeurs — et l'argv reste
dans le workspace, où le projet peut être lu d'un bout à l'autre. Un override qui
nomme une commande ou un argument inexistant est refusé plutôt qu'ignoré, et un
override qui laisserait un argument sans valeurs ni pattern aussi : les trois
seraient sinon des no-ops silencieux.

Et le harness a refusé d'écrire une autre chose au passage. `optional` et « sans
contrainte » sont deux mots différents, et la première version les confondait :
`["cargo","test","-p","{target}"]` avec un `target` optionnel produisait
`cargo test -p`, un flag orphelin, pas « pas de cible ». Trouvé en écrivant le cas
optionnel comme test. Refusé au chargement du workspace maintenant, avec le
correctif nommé dans le message.

---

## 2. `every_command` passait sans rien exécuter — **confirmé, et c'est le plus

gros des quatre**

Ton diagnostic est exact et c'est celui qui coûte le plus cher, parce que le mode
d'échec est **le succès**. Le filtre ne matche aucun test, `cargo test` sort **0**
et affiche `0 passed; 0 failed`, et ça se lit comme un check vert. Le vrai test est
bien `the_sample_covers_every_command_once`.

Le code de sortie ne peut pas attraper ça, parce que le code de sortie a raison.
Donc le projet dit ce à quoi une preuve ressemble, dans les mots de son propre
outil :

```json
"expect": "test result: ok\\. [1-9]"
```

et un appel dont la sortie ne matche pas est rapporté comme
`[harness] not proven:` et **ne compte pas comme un pass**.

Trois précisions, parce qu'elles décident si c'est une bonne idée ou non :

- **Le harness n'apprend toujours pas ce qu'est un test.** `expect` est une regex
  écrite par le projet, dans `commands.ts` il n'y a toujours ni `cargo`, ni
  `vitest`, ni `playwright`. `test result: ok\. [1-9]` pour cargo,
  `Tests\s+[1-9]\d* passed` pour vitest.
- **C'est testé avant que `keep` ne coupe la sortie.** `keep` est un motif pour ce
  qu'un lecteur veut lire, et la ligne qui prouve qu'une commande a tourné n'est
  justement pas intéressante à lire. Tester `expect` sur le texte déjà coupé
  ferait échouer exactement les commandes qui marchent.
- **Un `expect` qui n'est pas une regex compte comme non prouvé, pas comme un
  pass.** Une faute de frappe dans un fichier de config ne doit pas pouvoir
  devenir une coche verte.

Ce que ça donne dans le template, sur les quatre commandes de test :

```json
"keep": "^(error|failures|test result|---- |thread '.*' panicked)",
"expect": "test result: ok\\. [1-9]",
```

Pour `ui_spec` et `vitest`, `expect` est `[1-9]\\d* passed` et
`Tests\\s+[1-9]\\d* passed`.

**À faire de ton côté :** ton `.dsh/workspace.json` a les bons `run` mais aucun
`expect`. Ajoute-le sur `run_test`, `run_unit_tests`, `registry`, `ui_spec` et
`vitest` — c'est la seule différence entre ta version et celle du template
maintenant.

---

## 3. `ui_spec` allait expirer la première fois — **confirmé, et j'ai pris ta

branche `setup`**

C'est le bon diagnostic : chaque `xtask ui` fait un `npm run build` **et** un
build debug de l'app, et dans un `{worktree}-target` neuf ça dépasse largement
300 s.

J'ai pris la branche « le setup construit l'app aussi » plutôt que celle du
timeout plus long, pour une raison : allonger le timeout ne fait que déplacer le
coût, il ne l'enlève pas. Deux conséquences :

```json
"setup": [
  { "run": ["cargo", "build", "-p", "emils-planner-avoid"], "timeoutSeconds": 1800 },
  { "when": ["package.json"], "run": ["npm", "run", "build", "--silent"], "timeoutSeconds": 900 },
  {
    "when": ["Cargo.toml"],
    "run": ["cargo","build","--profile","dev","-p","emils-planner-app","--features","self-test,custom-protocol"],
    "timeoutSeconds": 3600
  }
]
```

Le `timeoutSeconds` de `ui_spec` monte quand même à 3600, pour la raison que tu
donnes : sur un worktree froid le build est la partie lente, et ce n'est pas au
premier appel d'une commande de le payer deux fois.

`setup` tourne **une fois par worktree** et pas une fois par run — le marqueur est
un fichier, donc un worktree réutilisé ne rebuild pas. Les trois étapes
représentent jusqu'à une heure ; c'est pour ça que chacune peut maintenant porter
une `description`, parce que la raison n'est jamais dans la commande et il n'y a
pas de commentaire en JSON.

---

## 4. `notify.mjs` n'existe pas — **confirmé, et c'est ce qui a fait `dsh watch`**

Tu as raison sur toute la ligne, y compris sur « une sécurité, pas un besoin ».
La réponse est `dsh watch --on-question`, et c'est aussi la réponse à « il
faudrait un canal ouvert ».

```
dsh watch <run>                                  suivre sans posséder
dsh watch <run> --quiet                          seulement questions, limites, strays, la fin
dsh watch <run> --on-question "notify-send dsh"  quelque chose te prévient
dsh watch <run> --json                           pour un script
```

**Pourquoi ce n'est pas un `onAsk` déguisé.** `onAsk` lance un processus **dans le
sandbox**, avec un environnement vidé et **sans shell**, parce que tout ce qu'il
exécute est du code que quelqu'un a écrit. `--on-question` tourne sur ta machine,
depuis une chaîne que tu as tapée toi, donc il a un shell — la question arrive sur
**stdin**, et `DSH_RUN` et `DSH_QUESTION` sont dans l'environnement pour tout ce
qui veut répondre au lieu de seulement crier.

**Pourquoi ce n'est pas `attach`.** `dsh run` est une **revendication** : il
démarre un run qui était en queue, et le run est annulé quand la dernière
connexion attachée s'en va. C'est juste pour celui qui l'a lancé et faux pour tout
le monde. Le daemon a donc une deuxième socket sur le même flux —
`/runs/:id/watch` — qui diffère sur exactement une chose, le drapeau `owns`, et
dans les deux sens : un veilleur ne peut pas démarrer un run et ne peut pas
l'arrêter. Fermer une fenêtre n'est qu'une fenêtre fermée.

Deux détails qui font la différence à l'usage :

- Une question **déjà répondue** n'est pas annoncée. Un veilleur lancé après coup
  reçoit tout l'historique — c'est voulu, c'est le cas normal — et sans ça il
  enverrait une notification sur laquelle personne ne peut rien faire, ce qui est
  la façon la plus rapide d'apprendre à ignorer les notifications.
- Un notifieur qui échoue est **avalé**. Le boulot du veilleur est de survivre et
  de continuer à rapporter ; un `notify-send` cassé ne doit pas l'emporter.

Vérifié en live : run détaché, veilleur avec notifieur, le notifieur reçoit la
question sur stdin avec l'id, `dsh reply` répond, le veilleur voit la réponse et
la sortie.

---

## Les deux autres, trouvés en corrigeant

**Le chemin de profil était doublé.**
`"profiles": { "default": "profiles/esap.json" }` **dans un fichier qui est déjà
dans `profiles/`** : ça résolvait vers `profiles/profiles/esap.json`. C'est le
genre de faute qui n'est pas visible à la lecture et qui donne « le workspace
nomme default mais il n'y a pas de fichier à … ». Corrigé en `"esap.json"`.

**Un exemple non chargé dérive.** Les six fautes ci-dessus étaient toutes
invisibles à la lecture, donc `workspace.test.ts` charge maintenant les exemples
du dossier `profiles/` comme n'importe quel workspace, vérifie que chaque chemin
de profil et de règles résout depuis l'endroit où l'exemple se trouve, et que
chaque `expect` et `keep` compile. Un exemple qui ne marche pas est pire que pas
d'exemple : c'est une page de copier-coller qui enseigne la mauvaise forme.

---

## Les trois questions

### « Claude n'a pas compris qu'il y a des presets »

Le mot n'était nulle part, donc c'est notre faute et pas la tienne. Ce qu'il y a
dans `profiles/` est un preset, pas de la documentation :

```
profiles/esap.json            un profil : les checks et les formatters
profiles/esap.rules.md        les notes du projet, ajoutées à chaque tâche
profiles/esap.workspace.json  le workspace, qui relie les deux
```

Un `dsh.workspace.json` dans le projet, pointant vers ses propres copies des deux
autres, c'est toute l'installation. Chaque nom `emils-planner-*` là-dedans est
celui d'esap et doit être remplacé — le harness ne sait pas ce que ces crates
sont, et c'est le but plutôt qu'une limite.

Le README a maintenant une section dessus. Et ce que tu as fait — ton propre
`.dsh/` — est la bonne réponse : depuis le 4ᵉ commit, `.dsh/**` est refusé en
écriture, pas seulement `.dsh/workspace.json`. Un profil est exactement la chose
que l'agent ne doit pas pouvoir éditer, parce qu'un check qu'il peut réécrire est
un check qui ne peut plus le refuser.

### « J'espère que Claude peut dire que la session dure au maximum 1 h »

Oui, et c'était une vraie lacune. Le message de tâche s'ouvre maintenant là-dessus,
en minutes :

```
How long you have: at most 60 minutes of wall clock and 12 model calls, whichever
arrives first, and $0.02 to spend. The clock does not pause while you wait for an
answer to ask, and every command you run is on it, so spend neither on anything you
do not need. Finishing less and saying so beats being stopped mid-change.
```

**Attention, deux horloges différentes, et je pense que c'est là que ça a
dérapé.** Dans ton `.dsh/workspace.json` tu as mis `"askSeconds": 300`. Ça
**n'est pas** la durée de la session :

- `askSeconds` = combien de temps un `ask` attend une réponse avant d'abandonner.
- `wallSeconds` = la durée de la session. Il vit dans `limits`, dans le **task
  file**, et vaut 900 (15 min) par défaut.

Donc 300 veut dire « une question attend 5 minutes », pas « la session dure 5
minutes ». Et pour avoir une session d'une heure il faut, dans le task file :

```json
"limits": { "wallSeconds": 3600 }
```

Ce que le message dit aussi, et c'est la moitié utile : **l'horloge ne s'arrête
pas pendant que l'agent attend une réponse**, et chaque commande lancée est
dessus. Sur neuf runs réels, sept se sont arrêtés à une limite et dans chaque cas
l'agent n'avait aucun avertissement et aucune idée de l'horloge qui allait
l'arrêter. Un run qui sait qu'il a 15 minutes ne planifie pas comme un run qui
croit avoir une heure — et le temps réel était la seule chose que le message de
tâche ne disait jamais.

Vérifié en live : un run à qui on demande de redire son propre budget répond
« at most 60 minutes of wall clock and 4 model calls (whichever arrives first),
with a $0.020 budget ».

### Le canal ouvert

`dsh watch` ci-dessus. Pour que ce soit utilisable comme tu le veux — tu lances un
run et tu veux être prévenu — la forme est :

```
dsh run task.json --detach
dsh watch <run> --quiet --on-question "notifieur"
```

Le `--quiet` ne laisse passer que ce sur quoi une personne doit agir : les
questions, les limites, les changements hors plan, le résumé, la fin.

---

## Ce qui reste

**Tout est fini.** Le point 4 des 14 — les globs dans `allow` et `soft` — a été
réglé au passage, et il était cassé plus gravement que noté : `allowed.has(path)`
partout, `matchesGlob` à côté, correct, jamais appelé. `"allow": ["docs/**"]`
n'autorisait qu'un fichier littéralement nommé `docs/**`. Trouvé en live, sur le
run de vérification de ce document.

Il reste une chose à faire de ton côté, et c'est le seul point d'action :
ajouter `expect` aux cinq commandes de test de `F:\vsCode\EmilsSuperAppPlanner\.dsh\workspace.json`.
