Vendored copy of `conformance/v0.2/` from github.com/cryptonomicsed-byte/sid
(the vectors, the trust anchors and the PUBLIC TEST KEYS). The kernel's
identity verifier must agree with every vector. To refresh:

    cp ../../../../sid/conformance/v0.2/{vectors,trust,test-keys}.json .

`SOURCE_SHA256` is checked by a test so a stale or edited copy is noticed.
