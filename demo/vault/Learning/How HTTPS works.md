# How HTTPS works

Notes from [How HTTPS keeps data private](chat:6f1c2a3e-8b4d-4e5f-9a0b-1c2d3e4f5a61).

- HTTPS = HTTP inside an encrypted **TLS** connection.
- Before sending data: prove **identity** (certificate), agree on a key (==TLS handshake==[^1]), then **encrypt** everything.
- An eavesdropper sees *which* site, not *what* you send.

<details>
<summary>Agreeing on a key without sending it</summary>

**Diffie-Hellman:** each side keeps a private random number and sends only a public value. Both combine their private number with the other's public value and get the same secret. Like mixing paint: easy to mix, practically impossible to un-mix.
</details>

## "Not secure" warnings

| Cause | What's wrong |
|---|---|
| Plain HTTP | Nothing is encrypted |
| Certificate problem | Expired, wrong domain, or untrusted signer |
| Mixed content | Some resources load over plain HTTP |

Related: [[Big-O cheat sheet]]

[^1]: The handshake also checks the certificate, so you know the key belongs to the real site.
