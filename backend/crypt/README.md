# Crypt

`crypt` remotes encrypt and decrypt other remotes.

A remote of type crypt does not access a storage system directly, but instead
wraps another remote, which in turn accesses the storage system. This is similar
to how alias, union, chunker and a few others work. It makes the usage very
flexible, as you can add a layer, in this case an encryption layer, on top of
any other backend, even in multiple layers. rfetch's functionality can be used
as with any other remote, for example you can mount a crypt remote.

Accessing a storage system through a crypt remote realizes client-side
encryption, which makes it safe to keep your data in a location you do not trust
will not get compromised. When working against the crypt remote, rfetch will
automatically encrypt (before uploading) and decrypt (after downloading) on your
local system as needed on the fly, leaving the data encrypted at rest in the
wrapped remote. If you access the storage system using an application other than
rfetch, or access the wrapped remote directly using rfetch, there will not be
any encryption/decryption: Downloading existing content will just give you the
encrypted (scrambled) format, and anything you upload will not become encrypted.

The encryption is a secret-key encryption (also called symmetric key encryption)
algorithm, where a password (or pass phrase) is used to generate real encryption
key. The password can be supplied by user, or you may chose to let rfetch
generate one. It will be stored in the configuration file, in a lightly obscured
form. If you are in an environment where you are not able to keep your
configuration secured, you should add configuration encryption as protection. As
long as you have this configuration file, you will be able to decrypt your data.
Without the configuration file, as long as you remember the password (or keep it
in a safe place), you can re-create the configuration and gain access to the
existing data. You may also configure a corresponding remote in a different
installation to access the same data. See below for guidance to changing
password.

Encryption uses cryptographic salt, to permute the encryption key so that the
same string may be encrypted in different ways. When configuring the crypt
remote it is optional to enter a salt, or to let rfetch generate a unique salt.
If omitted, rfetch uses a built-in unique string. Normally in cryptography, the
salt is stored together with the encrypted content, and do not have to be
memorized by the user. This is not the case in rfetch, because rfetch does not
store any additional information on the remotes. Use of custom salt is
effectively a second password that must be memorized.

File content encryption is performed using NaCl SecretBox, based on XSalsa20
cipher and Poly1305 for integrity. Names (file- and directory names) are also
encrypted by default, but this has some implications and is therefore possible
to be turned off.

### Standard options

Here are the Standard options specific to crypt (Encrypt/Decrypt a remote).

#### --crypt-remote

Remote to encrypt/decrypt.

Normally should contain a ':' and a path, e.g. "myremote:path/to/dir",
"myremote:bucket" or maybe "myremote:" (not recommended).

Properties:

- Config: remote
- Env Var: RCLONE_CRYPT_REMOTE
- Type: string
- Required: true

#### --crypt-password

Password or pass phrase for encryption.

**NB** Input to this must be obscured - see [obscure](/cmd/obscure/).

Properties:

- Config: password
- Env Var: RCLONE_CRYPT_PASSWORD
- Type: string
- Required: true

#### --crypt-password2

Password or pass phrase for salt.

Optional but recommended. Should be different to the previous password.

**NB** Input to this must be obscured - see [obscure](/cmd/obscure/).

Properties:

- Config: password2
- Env Var: RCLONE_CRYPT_PASSWORD2
- Type: string
- Required: false
