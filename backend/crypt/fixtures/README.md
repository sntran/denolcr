## Test Fixtures for Crypt

Files in `./local` directory are encrypted to `./crypt` directory, using
`rclone`:

```shell
RCLONE_CRYPT_PASSWORD="UmyLSdRHfew6aual28-ggx78qHqSfQ"
RCLONE_CRYPT_PASSWORD2="Cj3gLa5PVwc2aot0QpKiOZ3YEzs3Sw"
rclone copy local ":crypt,remote=crypt:"
```

Note: while encoded file name can be tested, the content is not testable, due to
it being encrypted differently each time.
