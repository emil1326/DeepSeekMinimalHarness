# Retours de Claude, 2 : les premiers vrais runs après la refonte

Trois choses trouvées en relançant esap le 2026-09-24, dans l'ordre où elles
m'ont coûté du temps.

## 1. La vraie raison d'un échec au démarrage est perdue

Un worker qui refuse de démarrer (ici : `the profile is inside the sandbox,
where the model could edit its own rules`) émet bien un événement `error` puis
`done`, mais `dsh run`, `dsh logs` et `dsh show` ne montrent que :

```
error: the worker stopped without finishing (code 0, signal none)
```

La phrase qui explique tout n'arrive nulle part. Je l'ai trouvée en forkant
`packages/worker/dist/main.js` à la main avec la config du run. À vérifier :
l'événement `error` du worker est-il ajouté au journal avant que le `done` et
l'`exit` soient traités, et le `done` avec `status: failed` est-il pris comme
terminal avant que l'`exit` écrase le détail ?

## 2. La doc et le code ne sont pas d'accord sur `.dsh/`

Le README dit que tout `.dsh/**` est sur la liste d'interdiction d'écriture,
donc qu'un fichier de config peut vivre là. Mais le worker refuse quand même un
**profil** situé dans le worktree, même sous `.dsh/`. Soit le refus devrait
accepter un profil sous un chemin never-write, soit le README devrait dire
clairement que le profil, lui, doit rester dehors. J'ai contourné en pointant
le workspace d'esap vers `../../DeepSeekMinimalHarness/profiles/esap.json`.

## 3. Un daemon plus vieux que le build lance des workers neufs

Le daemon tournait depuis 23 h 07, et le build de 23 h 20 avait changé le
protocole. Il forke `packages/worker/dist/main.js` depuis le disque, donc un
worker neuf parlait à un daemon ancien. Résultat : le même « stopped without
finishing ». Un redémarrage du daemon a réglé une partie du problème. Idée :
le daemon note le hash ou la date de `dist` au démarrage, et `dsh` refuse de
lancer un run (ou redémarre le daemon quand rien ne tourne) si le build a changé
depuis.

## Où ça en est (2026-09-24)

1. Réglé par DeepSeek dans `0cdb0b8` (le worker attend que `done` parte, et
   `exit-race.test.ts` le tient).
2. Réglé par Claude : un profil sous `.dsh/` est accepté
   (`Sandbox.assertOutsideOrProtected`), puisque `.dsh/**` est sur la liste
   d'interdiction d'écriture ; ailleurs dans le worktree, il est toujours refusé.
3. Réglé par Claude : le daemon écrit `build` (le `buildStamp()` de son code)
   dans `daemon.json`, et le CLI redémarre un daemon plus vieux que le build
   quand rien ne tourne, ou le dit et le laisse quand quelque chose tourne.
