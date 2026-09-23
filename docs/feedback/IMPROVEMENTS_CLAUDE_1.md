# Ce que Claude voudrait voir arriver dans le harness

Écrit le 2026-09-23 par Claude, après environ 55 runs DeepSeek Flash sur esap (19 plans, 36 implémentations) pendant la phase 9. Les points sont triés par ce qu'ils auraient épargné, le plus rentable en premier.

Le chiffre qui motive tout ça : aucun run n'a planté côté harness, mais seulement 3 ou 4 lignes du backlog sur 16 ont passé le gate complet d'esap sans correction de ma part. Presque tout le reste tombait sur des choses que l'agent ne pouvait pas voir, parce qu'il n'exécute aucun test.

Déjà là et pas redemandé : `continue`, `report`, `limits`, `limit`, `stats`, l'avertissement à 80 % d'un budget. (Mes scripts n'utilisaient pas encore `continue` ; je vais m'y mettre.)

---

## 1. Laisser l'agent exécuter les tests qu'il écrit

**Le plus gros gain, de loin.** À peu près la moitié de mes corrections, ce sont des tests que DeepSeek a écrits et qui échouaient à la première exécution. Il ne pouvait pas le savoir : le profil esap n'a que des checks statiques (`cargo_check`, `clippy`, `cargo_fmt`, `typecheck`, `eslint`, `prettier`).

Exemples réels de cette session :

- supposer que des ids aléatoires sortent dans l'ordre de création ;
- des ids tapés à la main qui ne sont pas des ids valides (`7kq2m9pd4a1cz`) ;
- une commande qui enregistre une heure, appelée sans passer par la couche bundle (« this write has no time ») ;
- deux champs du même nom sur un même objet ;
- un test qui compare `type` alors que la ligne l'appelle `reference`.

Ce que je voudrais :

- deux checks nouveaux, `cargo_test` et `vitest`, **limités à ce que la tâche nomme** : `cargo test -p <crate> --test <nom>` et `vitest run <fichier>`. Pas toute la suite ;
- la tâche déclare les cibles, par exemple `"tests": { "cargo": ["emils-planner-core:comments"], "vitest": ["src/fields.test.ts"] }`, et l'agent ne peut rien lancer d'autre ;
- un timeout par exécution (60 s me paraît juste pour une cible) ;
- la sortie renvoyée à l'agent tronquée aux échecs : le nom du test, le message du panic ou de l'assertion, et les 20 lignes autour. Pas les centaines de lignes « ok ».

Côté sécurité : exécuter un test, c'est exécuter du code écrit par l'agent. Emil a dit que la sécu n'a pas besoin d'être parfaite, mais « pas de classifieur, donc sécurité d'abord ». Le compromis que je propose :

- lancer ces checks dans un **Job Object Windows** avec une limite mémoire et de durée, sans processus enfants persistants ;
- si possible, dans un AppContainer sans réseau ;
- à défaut, au moins bloquer le réseau via le pare-feu pour le binaire de test ;
- dans tous les cas, `build.rs` et les proc macros ne doivent pas changer à l'intérieur d'un run (ce qui est déjà refusé si j'ai bien lu).
- idee de emil -> au lieux de pas verifier les tests et les executer, lancer une instance de flash as classifier pour checker genre, est ce que le test semble safe a rouler ?, intrant quand meme small, on peut pas donner a l'agent classifier genre 100k tokens ,mais on peut quand meme le faire tester des choses

## 2. Une spec UI à la fois, par le verrou existant

L'autre moitié de mes corrections, ce sont des bugs que seule une spec Playwright a montrés. Ce sont souvent de vrais bugs produit, que ses propres specs auraient révélés s'il avait pu les lancer :

- `filled()` qui ignorait une valeur JSON, si bien que le panneau se rouvrait au lieu d'écrire, sans rien dire ;
- la barre latérale qui passait sous le dock de style et perdait ses clics ;
- une closure React figée sur le premier rendu ;
- un nom de facette jamais résolu en id ;
- une spec que le résumé disait réécrite et qui ne l'était pas.

Ce que je voudrais : un check `ui_spec` qui prend un nom de spec et lance `cargo xtask ui "<nom>"`. Ça passe par le verrou machine d'esap, donc ça attend si une autre mesure tourne, et ça ne lance qu'une spec (quelques secondes, pas les 4 minutes de la suite). Les specs partagent une seule app : lancée seule, une spec ne dit rien de ce qu'elle laisse derrière elle pour la suivante. Ça reste mon travail au gate, mais le gros des bugs serait attrapé avant.

## 3. Un mode « personne ne regarde »

Le run 9b-L1 a posé une question par `ask` (« puis-je modifier une ligne de `wire.rs` ? ») et a attendu une heure pour rien, parce que je le lançais sans surveiller.

- un drapeau de tâche `"unattended": true` qui fait répondre `ask` tout de suite : « Personne ne répond. Décide, note la décision dans ton résumé et continue. » ;
- ou, plus simple, `askSeconds` à 60 par défaut plutôt qu'à 3600 ;
- et dans le rapport, une section « questions posées et réponse reçue (ou pas) ».
- idee de emil -> prehaps, sa devrait plutot etre une notification qui viens a l'agent qui call au debut, donc genre, claude commence un harness sur une tache, work work dessus, get une notif, yo, somethings wrong, need help, pis genre tigidou

## 4. Une liste de fichiers autorisés moins cassante

Deux cas se répètent :

- **il manque un fichier évident**, comme une ligne à ajouter dans `wire.rs` quand une struct gagne un champ, ou un test de registre qui liste toutes les commandes. L'agent s'arrête ou contourne ;
- **les fichiers de test voisins**, qu'il faut presque toujours toucher et qu'on oublie de lister.

Idées, de la plus simple à la plus fine :

- des globs dans `allow` (`crates/*/tests/**`) ;
- une liste `"soft"` : les fichiers qu'il peut modifier, mais qui sont signalés au rapport comme hors plan ;
- un outil `request_file(path, why)` que l'orchestrateur approuve automatiquement selon une règle (même crate, fichier de test), sinon refusé tout de suite, sans attente.

## 5. Un build par worktree

Les deux sandboxes partageaient `CARGO_TARGET_DIR`. Résultat : un `cargo check` dans l'une a affiché les erreurs de l'autre, et un run a conclu à tort « cargo_check échoue sur un trou de la partie 1 » alors que tout compilait.

- le profil devrait fixer `CARGO_TARGET_DIR` **par worktree**, par exemple `<worktree>/../<nom>-target`, sans que la tâche ait à y penser ;
- une étape `setup` par profil, lancée une fois par worktree : pour esap, `cargo build -p emils-planner-avoid`, faute de quoi les tests de routage échouent par dizaines pour une DLL absente.

## 6. Un résumé final qui ne peut pas mentir

Le run 9b-A1 partie 2 a écrit « `ui/add.spec.ts` rewritten » alors que le fichier n'avait pas changé. Je ne l'ai vu qu'au gate.

- à la fin du run, le harness ajoute au rapport le vrai `git diff --stat` du worktree ;
- il compare les chemins cités dans le résumé de l'agent avec ceux du diff, et **signale chaque fichier annoncé comme modifié mais inchangé** ;
- il sort aussi un JSON final lisible par machine, pour que mes scripts n'aient plus à parser du texte : statut, fichiers changés, dernier résultat de chaque check, tours, tokens, résumé.

## 7. La base des « stray changes »

Quand je lance un deuxième run dans un worktree qui contient déjà le travail du premier, `STRAY CHANGES OUTSIDE THE ALLOWED FILES` liste tous les fichiers du premier run. La base de comparaison devrait être **l'état du worktree au début du run** (un `git stash create` ou un snapshot des empreintes), pas `HEAD`. Sinon le signal est noyé.

## 8. Un outil `format` limité aux fichiers autorisés

Au moins une fois, `format` a reformaté des fichiers hors de la liste (dérive `rustfmt` déjà présente). Il devrait ne toucher que les fichiers autorisés que le run a modifiés.

## 9 -> non -emil

## 10. Des règles de projet injectées dans chaque tâche

J'ai recopié les mêmes pièges dans chaque brief. Ils devraient vivre dans le profil (`"rules": "profiles/esap.rules.md"`) et être ajoutés à chaque tâche :

- ids aléatoires : ne jamais dépendre de l'ordre ni de l'index 0 ;
- ne jamais comparer une réponse entière du core, qui porte `core_ms` ;
- l'app tourne en français sur cette machine : les specs lisent des attributs `data-*`, jamais du texte ;
- une spec remet l'app exactement comme elle l'a trouvée (panneau fermé, focus sur `.dock`, nettoyage dans un `finally`) ;
- une commande qui enregistre une heure se teste par `bundles::apply_as` ;
- une nouvelle commande du core va dans l'échantillon `every_command` de `tests/registry.rs`, dans un menu que l'app connaît, et sur `NOT_BUILT` tant que l'app ne l'exécute pas ;
- un golden manquant ne se crée jamais à la main ;
- ne jamais poser de question : noter la décision et continuer.

## 11. Mesurer le vrai taux de réussite

`dsh stats` donne la vitesse et le coût. Il manque ce qui compte pour savoir si ça vaut le coup : **est-ce que le travail a atterri ?**

- `dsh tag <run> landed|fixed|dropped [--note "..."]` que l'orchestrateur appelle après le gate ;
- dans `stats` et l'UI : par modèle et par profil, la part des runs finis, arrêtés à la limite, puis atterris tels quels, corrigés ou jetés ;
- et le coût par ligne atterrie, qui est le seul coût qui dise quelque chose.

## 12. Crédits épuisés : un code de sortie à part

Emil a dit de s'arrêter proprement si les crédits DeepSeek tombent. Aujourd'hui je ne sais pas ce qu'un solde insuffisant donne. Je voudrais un code de sortie distinct (par exemple 6, « le fournisseur refuse : solde ») et un message clair, pour que l'orchestrateur arrête de lancer au lieu de réessayer.

## 13. Des outils de worktree

Ce que mes scripts refont à la main à chaque ligne :

- `dsh worktree new <nom> --from <commit>` : worktree plus jonction `node_modules`, plus le build de setup (point 5) ;
- `dsh worktree reset <nom> <commit>` ;
- `dsh patch <run>` : le patch binaire des changements du run, prêt pour `git apply --3way`.

## 14. À vérifier, signalé plus tôt

Remontés dans mon premier retour. Le dernier point est corrigé dans le code (`checkOrigin` refuse `null`), les autres je ne les ai pas revérifiés :

- des checks statiques qui exécutent du code (configs prettier et eslint, proc macros) : les refus ont été ajoutés, un test de non-régression par cas serait bien ;
- le mode dev qui prend la place du vrai daemon ;
- des métriques de décodage anciennes mélangées aux nouvelles dans `stats` ;
- `Origin: null` : corrigé.
