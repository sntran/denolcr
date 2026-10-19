# The test files of the archive backend

RAR 6.20 for Linux of RARLAB made the RAR files. It is the last version that
writes RAR4 (`-ma4`). The files are in the repository, thus the tests do not
need RAR. 7-Zip 25.01 tested each file with `7zz t`.

The folder of the archives has these files. The time of each file is
2024-05-06T07:08:09Z.

- `a.txt`: `hello` and a line break.
- `empty.txt`: no bytes.
- `folder/large.txt`: 20,000 bytes of text.
- `folder/deep/random.bin`: 3,000 random bytes.
- `êé/Hello, 世界.txt`: `z` and a line break.
- `empty folder/`.

The commands, in that folder, with `TZ=UTC` and `LC_ALL=C.UTF-8`:

```sh
rar a -r -ma5 -m0 store5.rar *
rar a -r -ma4 -m0 store4.rar *
rar a -r -ma5 -m0 -s solid5.rar *
rar a -r -ma5 -m3 compressed5.rar *
rar a -r -ma4 -m3 compressed4.rar *
rar a -r -ma5 -m0 -v10k volumes.rar *
rar a -ma5 -m0 -pfixture-password password5.rar a.txt
rar a -ma5 -m0 -hpfixture-password headers5.rar a.txt
rar a -ma4 -m0 -pfixture-password password4.rar a.txt
```

The password of the files with a password is `fixture-password`.
