#!/usr/bin/env python3
"""Apply the two equivalent list swaps required by Mono's C# compiler."""
import pathlib, sys
p = pathlib.Path(sys.argv[1])/'Game/AI/Decks/ThunderDragonExecutor.cs'
s = p.read_text()
for name in ['copy_cards', 'link_materials']:
    old = f'({name}[i], {name}[0]) = ({name}[0], {name}[i]);'
    new = f'var swapCard = {name}[i]; {name}[i] = {name}[0]; {name}[0] = swapCard;'
    assert old in s
    s = s.replace(old, new)
p.write_text(s)
