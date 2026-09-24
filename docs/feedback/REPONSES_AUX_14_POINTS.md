# Réponses aux 14 points

Réponse à `IMPROVEMENTS_CLAUDE_1.md`, point par point. Pour chacun : ce qui a été
fait, ou pourquoi non. Écrit après avoir lu le code plutôt que de mémoire, et
après avoir lancé les mécanismes contre la vraie API DeepSeek.

Trois points sur quatorze ne sont pas faits. Ils sont marqués **non fait** avec
la raison, et pas adoucis.

---

## 1. Laisser l'agent exécuter les tests qu'il écrit — **fait, autrement**

Ton diagnostic est le bon et c'est le plus gros gain du lot. Ton remède ne
pouvait pas être pris tel quel, parce que `PLAN.md` interdit les checks qui
exécutent du code, exprès, et que la raison n'est pas la paresse : `build.rs`,
`Cargo.toml`, `*.config.*`, les crates `proc-macro` et les dotfiles
`.prettierrc*`/`.eslintrc*` sont tous sur la liste d'interdiction d'écriture, donc
l'agent ne peut pas **introduire** d'exécution au build. Ce qui restait ouvert
était le corps du test, au runtime.

La réponse : **le harness n'apprend pas ce qu'est un test.** Le projet le dit.

```json
"commands": {
  "run_test": {
    "description": "Run one test target that this task owns.",
    "args": { "target": { "description": "a target", "values": ["core:comments"] } },
    "run": ["cargo", "test", "-p", "{target}"],
    "timeoutSeconds": 90,
    "keep": "^(error|FAIL|test result)",
    "executes": true
  }
}
```

Le harness en fait un outil. `commands.ts` ne contient ni `cargo`, ni `vitest`,
ni quoi que ce soit de ton projet — tout vient du fichier de config. Tes quatre
demandes y sont :

- **limité à ce que la tâche nomme** — c'est la liste `values` ;
- **timeout par exécution** — `timeoutSeconds`, 120 s par défaut ;
- **sortie tronquée aux échecs** — `keep`, un motif ; chez toi
  `^(error|FAIL|test result)` remplace cent lignes de « ok » par les quatre qui
  comptent. Le harness ne sait toujours pas ce qu'est un échec.
- **rien d'autre lançable** — la liste est fermée, voir ci-dessous.

### La décision qui porte tout : un argument est un ensemble fermé

L'argv est assemblé à partir d'arguments que **le modèle** a choisis, et
`process.ts` se donne beaucoup de mal pour qu'une chaîne écrite par le modèle
n'atteigne jamais un interpréteur de commandes. Un argument en texte libre rend
ça au niveau au-dessus : `["cargo","test","-p","{target}"]` avec `target` non
contraint, c'est un shell sous un autre nom, et `--target-dir=../../..` est un
argument — pas un chemin que le sandbox peut voir.

Donc chaque argument déclare soit `values` (la liste exacte), soit `pattern` (une
regex qu'il doit satisfaire en entier). Un argument qui n'a ni l'un ni l'autre
**fait échouer la lecture du workspace**, pas le premier appel du modèle : c'est
une erreur dans un fichier que tu as tapé, et c'est à toi qu'il faut la dire.

Deuxième règle : un placeholder doit être **un élément d'argv entier**.
`--package={target}` est refusé, parce que vérifier un bout d'une chaîne choisie
par le modèle et coller l'autre bout dans un argv ressemble à de l'échappement et
n'en est pas.

### Ce que je n'ai pas fait, et pourquoi

Pas de Job Object Windows, pas d'AppContainer, pas de blocage réseau. **Ton idée
de classifieur non plus.**

Un classifieur LLM n'est pas une frontière de sécurité : l'entrée est adverse,
c'est l'agent qui écrit le code, et un LLM se laisse convaincre par du code. Un
test avec `#[test] fn t() { /* safe */ exfiltrate() }` passe. Mais comme
**fil-piège** — détecter, pas empêcher — ça vaut le coup, et si tu le veux je le
branche en trace dans le rapport, pas en autorisation.

Ce qui reste ouvert, sans détour : **un test que l'agent écrit s'exécute avec tes
privilèges et peut lire `~/.deepseek/api_key`.** `SECRET_ENV` ne sert à rien ici,
la clé est dans un fichier, pas dans l'environnement. Le seul vrai remède est une
jail OS. Aujourd'hui la mitigation est que la liste des cibles est fermée et
qu'un `executes: true` apparaît dans le rapport — pas que ce soit sûr.

---

## 2. `ui_spec` — **fait, même mécanisme**

```json
"ui_spec": {
  "args": { "name": { "description": "the spec name", "pattern": "^[a-z][a-z0-9-]*$" } },
  "run": ["cargo", "xtask", "ui", "{name}"],
  "keep": "^(Error|expect|at |.*failed)"
}
```

Le verrou machine d'esap est dans `xtask`, donc il est respecté sans que le
harness ait à le connaître. `profiles/esap.workspace.json` a la version
complète, avec `run_test`, `ui_spec`, `vitest` et `every_command`.

Un avertissement que tu n'as pas mentionné et qui compte : lancer une seule spec
ne dit rien de ce qu'elle laisse derrière elle pour la suivante. Le mécanisme ne
change pas ça, il le rend juste moins cher.

---

## 3. Mode « personne ne regarde » — **`unattended` refusé, `onAsk` fait**

`"unattended": true` tel que tu le proposes met une **politique** dans le
harness : `ask` répond tout seul « décide et continue », et la décision n'est
jamais relue. Le problème du run 9b-L1 n'était pas « il a demandé », c'était
« personne n'a été prévenu ».

Ce qui est fait : le workspace déclare qui prévenir.

```json
"onAsk": { "run": ["node", "notify.mjs"], "timeoutSeconds": 15 }
```

La commande tourne au moment où la question est émise, avec la question sur
stdin et `DSH_RUN` / `DSH_QUESTION` dans l'environnement. Elle ne répond rien —
le harness ne devine pas — mais quelqu'un qui est prévenu peut faire un
`dsh reply`. C'est ton idée à toi (« yo, something's wrong, need help »), gardée
telle quelle, et c'est meilleur que la sienne parce que l'humain reste dans la
boucle.

`limits.askSeconds` est aussi réglable par workspace (`"askSeconds": 300`).
Je n'ai **pas** mis 60 s par défaut : c'est un plafond, donc 60 veut dire
« personne n'a répondu en une minute, tue le run ». Ça doit rester un choix par
tâche.

---

## 4. Liste de fichiers autorisés — **partiellement**

Fait : une liste `soft`, dans le workspace et/ou la tâche.

```json
"soft": ["ui/*.spec.ts", "crates/*/tests/**"]
```

Ces fichiers sont **écrivables**, et chaque modification est rapportée comme
`offPlan` — distincte d'un `stray`, qui veut dire « personne n'a autorisé ça ».
Les mélanger apprendrait à survoler la ligne qui crie.

Non fait : **les globs**. `soft` est en correspondance exacte, comme `allow`.
Ce n'est pas de la paresse, c'est que `{allowed}` énumère la liste d'autorisation
comme des chemins littéraux :

```ts
const files = [...this.allow].filter((a) => !when || when.some((s) => a.endsWith(s)));
```

Si tu mets `crates/*/tests/**` dans `allow`, la chaîne du glob part telle quelle
dans l'argv de prettier. Donc les globs demandent de **résoudre la liste en
fichiers concrets à la construction** tout en gardant le motif pour les nouveaux
fichiers. C'est là qu'est le travail, pas dans le matching, et c'est un
changement qu'il faut faire pour `allow` et `soft` ensemble.

`request_file(path, why)` : **non fait, et je ne le ferais pas.** Une approbation
automatique selon une règle (« même crate, fichier de test ») est une règle
écrite par toi qui décide à ta place, donc exactement les deux autres options
déguisées en troisième. `soft` couvre le besoin réel sans qu'une machine décide.

---

## 5. Un build par worktree — **fait**

C'était un vrai bug et il était dans le profil livré :

```diff
-  "CARGO_TARGET_DIR": "{parent}/esap-ds-target"
+  "CARGO_TARGET_DIR": "{worktree}-target"
```

Deux worktrees frères ont le même `{parent}`, donc le même target dir. Corrigé,
et `{worktree}` / `{name}` / `{home}` existent maintenant partout où `{parent}`
existait.

Et l'étape de setup, une fois par worktree :

```json
"setup": [{ "when": ["Cargo.toml"], "run": ["cargo","build","-p","emils-planner-avoid"], "timeoutSeconds": 600 }]
```

Avant le premier appel au modèle, dans le worktree, avec l'environnement du
workspace. Marquée par un fichier dans le home du harness, clé par (worktree,
étapes) — donc éditer les étapes les rejoue, et deux worktrees sont préparés
indépendamment. Le marqueur est hors du worktree pour ne pas apparaître dans le
diff du run.

Une étape qui échoue **n'arrête pas le run**. Elle est annoncée, et l'agent
travaille dans un arbre auquel il manque quelque chose — souvent récupérable.
Refuser de démarrer échangerait un succès probable contre un échec certain.

---

## 6. Un résumé qui ne peut pas mentir — **partiellement**

Fait :

- le rapport liste les fichiers d'après les **écritures du run lui-même** tirées
  de son journal d'événements, plus d'après git au moment de la lecture. Trouvé
  en lisant un vrai rapport : un run dont les deux éditions avaient été annulées
  depuis se décrivait comme n'ayant « rien changé », alors que son journal
  contenait les deux écritures depuis le début ;
- `onDisk` est gardé **à côté**, et le rapport (CLI et UI) dit quand les deux
  divergent — c'est le seul cas où un lecteur a besoin de savoir lequel il
  regarde ;
- `dsh report --json` existe déjà et donne statut, fichiers, dernier résultat de
  chaque check, tours, tokens, résumé.

Vérifié en live : `changed  src/one.ts, src/two.ts` vient maintenant du journal,
pas de git.

Non fait : **comparer les chemins cités dans le texte du résumé avec le diff**.
Ton approche est fragile — « j'ai lu `src/a.ts` » n'est pas une prétention de
modification, et le rapport crierait au mensonge sur une lecture. La bonne
version est que `finish` prenne un `changed: string[]` optionnel et que le
harness le confronte à la réalité : lisible par machine, aucune heuristique sur
de la prose. Ce n'est pas fait.

---

## 7. La base des stray changes — **fait, mais ton diagnostic était faux**

`strayChanges` ne comparait **pas** à `HEAD`. Il comparait les fichiers changés à
la liste d'autorisation. Ton scénario était réel, ta raison non.

Et il faut être juste : « ce worktree contient des changements que cette tâche
n'autorisait pas » était _littéralement vrai_, c'est le contrôle qui fait son
travail.

Ce qui est fait : une photo (`git status --porcelain`) prise **avant le premier
appel au modèle**. Le rapport distingue trois choses :

- `stray` — changé, sur aucune liste, et **pas** dans la photo ;
- `offPlan` — changé, sur la liste `soft` ;
- `preExisting` — déjà changé avant le run, donc pas son fait.

Vérifié en test : un fichier modifié avant le run n'est pas rapporté comme un
stray, et un fichier soft n'est pas rapporté comme un stray non plus.

---

## 8. Un outil `format` limité — **fait**

`cargo fmt --all` ignore `{allowed}` et reformate des fichiers que le run n'a
jamais eus. Corrigé :

```diff
-{ "when": [".rs"], "run": ["cargo", "fmt", "--all"] }
+{ "when": [".rs"], "run": ["cargo", "fmt", "--", "{allowed}"] }
```

Le **check** `cargo_fmt` garde `--all --check`, et c'est délibéré : un check ne
fait que lire, et rapporter sur tout le workspace est ce qu'on lui demande. C'est
l'écriture qu'il fallait limiter.

Réserve honnête : `cargo fmt -- <fichiers>` n'est pas strictement équivalent à
`rustfmt <fichiers>` — le module tree et la config de crate peuvent différer.
À vérifier en live sur esap plutôt qu'à supposer.

---

## 9. — _(skippé par Emil)_

---

## 10. Des règles de projet injectées — **fait**

```json
"rules": "esap.rules.md",
"rulesText": "une phrase ou deux, pour un projet qui n'a pas besoin d'un fichier"
```

Deux champs et pas un. Un champ qui est un chemin quand le fichier existe et du
texte quand il n'existe pas lit bien et **est un piège** : un chemin avec une
faute de frappe est un fichier qui n'existe pas, donc les règles deviennent
silencieusement le chemin lui-même et le run travaille à partir de `notes.m`
comme instruction. Deux champs ne peuvent pas être mal lus.

Un `rules` qui nomme un fichier absent **fait échouer la résolution**. Des règles
qui disparaissent sont pires que des règles jamais écrites, parce que la config
du run dit qu'il les avait.

Les règles sont ajoutées **après** le texte de la tâche, et stockées dans la
config du run. C'est ce qui les rend stables : une continuation rejoue la
conversation verbatim, donc des règles qui changeraient sous elle laisseraient
l'agent travailler aux anciennes sans que rien ne le dise. `esap.rules.md` a tes
huit règles.

---

## 11. Mesurer le vrai taux de réussite — **NON FAIT**

Rien n'a été fait ici. Pas de `dsh tag`, pas de part de runs atterris, pas de
coût par ligne atterrie.

Ce qui existe et qui s'en approche sans le faire : `dsh stats` par modèle et par
méthode de mesure, le coût par run, et le rapport dit pour chaque run s'il a
fini, s'est arrêté, ou a échoué, et si ses propres checks le soutiennent.

Mon avis sur l'ordre : c'est **le plus rentable des trois qui restent**, parce que
sans lui vous optimisez à l'aveugle — « 60 % des runs s'arrêtent sur une limite »
et « 60 % des runs échouent » demandent des corrections opposées. `dsh tag <run>
landed|fixed|dropped` et une colonne dans `stats` est une petite journée.

---

## 12. Crédits épuisés — **fait**

`core/failure.ts` : un ensemble fermé de causes (`provider_balance`,
`provider_auth`, `provider_refused`, `provider_unreachable`, `harness`), portées
par l'événement `status` terminal — là où un lanceur regarde déjà, pas dans un
événement séparé qu'il faudrait savoir surveiller.

`dsh run` sort **6** pour `provider_balance` et `provider_auth`, les deux qui ne
se répareront pas tout seuls.

Le piège que tu n'avais pas vu : **lire de la prose pour distinguer « plus de
crédit » de « le modèle a mal répondu », ce n'est pas les distinguer.** `402` est
explicite, mais DeepSeek renvoie aussi un `400` avec « Insufficient Balance ».
Les indices sont donc des phrases étroites et non des mots : un `/balance/` nu
classerait une 400 sans rapport comme un compte à sec et **arrêterait un
orchestrateur pour rien**. Un cas manqué continue d'échouer bruyamment ; un faux
positif arrête du travail qui aurait continué.

Non vérifié en live : je n'ai pas fait échouer un vrai run sur un solde épuisé,
et je ne veux pas vider un compte pour le tester. La prochaine fois que ça
arrive, `--json` sur `dsh run` montrera `"cause":"provider_balance"`.

---

## 13. Des outils de worktree — **NON FAIT**

`dsh worktree new|reset`, `dsh patch`. Rien n'a été fait.

Ce qui existe déjà et qui fait une partie du travail : `setup` dans le
workspace (§5) couvre le build d'installation, et `dsh diff <run>` donne le diff
du worktree, que `git diff` sait déjà transformer en patch.

Le point qui aurait le plus de valeur est `dsh patch <run>` qui donne un binaire
prêt pour `git apply --3way`. Mais avec `changed` maintenant tiré du journal du
run (§6), le patch est reconstructible : ce sont les fichiers que le run a
écrits. À faire dans cet ordre.

---

## 14. À vérifier — **déjà réglé, sauf les contrôles**

Les quatre, vérifiés dans le code :

- **checks statiques qui exécutent du code** : `.prettierrc*`, `.eslintrc*`,
  `.babelrc*`, `.stylelintrc*`, `.markdownlint*`, `.npmrc`, `.yarnrc*` sont
  refusés à l'écriture ; les crates `proc-macro` sont refusées à la construction
  **et** à chaque écriture (`procMacroCrateOf`).
- **le mode dev qui prend la place du vrai daemon** : réglé, `-dev` a son propre
  home, vérifié en live avec les deux daemons qui tournent en même temps.
- **les métriques de décodage mélangées** : `METRICS_VERSION` /
  `LEGACY_METRICS_VERSION`, `summarise` groupe par modèle **et** par version,
  donc deux méthodes ne sont jamais moyennées.
- **`Origin: null`** : refusé.

Ce qui **reste** de ton point, et tu as raison de le soulever : un test de
contrôle par cas. La règle du dépôt est « tout test porteur a un contrôle :
casse la chose, regarde le test rougir, remets-la ». Les gardes existent, les
contrôles sont inégaux. C'est le travail qui reste sur ce point.

---

## Ce que ton document n'a pas nommé

Il y a un motif sous la moitié de tes points. Presque chacun ajoute un bouton au
**fichier de tâche** : `tests`, `ui_spec`, `setup`, `rules`, `soft`, `onAsk`.
Or ces choses sont **les mêmes pour toutes les lignes d'un projet**, et c'est
toi qui réécrivais le fichier de tâche à la main, une fois par ligne de backlog.

C'est ce qui a motivé le fichier de workspace. `dsh.workspace.json` porte la
config du projet **une fois**, et le fichier de tâche redevient ce qu'il aurait
dû être : _quelle ligne du backlog_. Tes points 1, 2, 5 et 10 disparaissent
dedans, et surtout disparaît l'endroit où tu te trompais en recopiant.

Un dernier piège à connaître : les règles et les commandes doivent être
**stables pendant un run**. C'est pour ça qu'elles sont stockées dans la config
du run et pas relues au vol. Si tu changes `rules` après qu'une continuation a
commencé, elle continue avec les anciennes et rien ne le dit.

---

## Les trois qui restent, dans l'ordre où je les ferais

1. **Le point 11** — sans lui, vous ne savez pas si un changement aide.
2. **Le point 6**, la comparaison résumé/diff — `finish` prend un `changed`, le
   rapport confronte. Débloque aussi le point 13.
3. **Les globs** dans `allow` et `soft` ensemble (§4).

Et **un projet hors du harness pour l'isolation OS des tests**, si tu veux que
l'agent puisse lancer des tests qu'un attaquant aurait écrits. Aujourd'hui la
liste fermée est ce qui protège, et elle protège bien contre le dégât accidentel
et pas du tout contre l'exfiltration.
