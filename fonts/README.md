# Bundled fonts

`inter-latin.woff2` and `inter-latin-ext.woff2` are the `latin` and `latin-ext`
subsets of [Inter](https://github.com/rsms/inter) v20, as served by Google
Fonts. They are bundled rather than fetched at runtime so that opening the
popup does not report to a third party, and so the UI looks right offline —
a normal state for a VPN extension.

Both are variable fonts covering the weight axis, which is why one file backs
both the 400 and 500 `@font-face` rules in `popup.html`. The `unicode-range`
declarations mirror Google's, so the browser still only loads the subset it
needs for the text on screen.

Inter is licensed under the SIL Open Font License 1.1; see `LICENSE.txt`.

To refresh, re-download the URLs from:

    curl 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=swap'

and copy the result into `firefox/fonts/` as well — the two extensions are
separate roots and cannot share files.
