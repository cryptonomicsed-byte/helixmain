#!/usr/bin/env python3
with open('/root/helixmain/dashboard/src/pages/card/SiteTab.tsx', 'r') as f:
    content = f.read()

# Find the closing </div> after the phone QR card and insert new QR before it
old = "          : <QrCard label=\"Call the business\" text=\"not set\" note=\"no phone on the card\" />}\n      </div>"
new = "          : <QrCard label=\"Call the business\" text=\"not set\" note=\"no phone on the card\" />}\n        <QrCard label=\"Talk to AI Agent\" text={`https://helixmain.duckdns.org/api/call/${id}`} note=\"scan to chat with Helix AI\" />\n      </div>"

if old in content:
    content = content.replace(old, new)
    with open('/root/helixmain/dashboard/src/pages/card/SiteTab.tsx', 'w') as f:
        f.write(content)
    print('SiteTab.tsx updated successfully')
else:
    print('ERROR: pattern not found')
    idx = content.find('Call the business')
    print(repr(content[max(0,idx-20):idx+200]))
