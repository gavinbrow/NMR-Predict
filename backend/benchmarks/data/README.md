# Reference shift dataset

`reference_shifts.json` is the ground-truth dataset the benchmark harness scores
engines against. Each record is one molecule with experimental `1H` and/or `13C`
chemical shifts grouped into chemical **scenario** buckets.

## How atoms are targeted: `group_smarts`

Reference shifts are **not** keyed to hard-coded atom indices (those break the
moment RDKit recanonicalizes). Instead each shift targets atoms via a SMARTS
pattern, resolved against the canonical, H-added molecule at scoring time.

The resolver (`benchmarks/dataset.py::resolve_reference_atoms`) treats the
**first atom of the SMARTS as the anchor**:

- **`13C`**: the anchor carbon is the scored atom. (If the anchor isn't a
  carbon, the first carbon in the match is used.)
- **`1H`**: the hydrogens bonded to the anchor heavy atom are the scored atoms.

When one pattern matches several symmetry-equivalent atoms (e.g. `[CH3]` for the
two methyls of isopropanol, or `[cH]` for all six benzene CH), every matched
atom is collected and the engine's predictions over that set are **averaged into
a single data point** before comparison. This keeps the comparison fair between
ORCA (which symmetry-averages equivalent atoms) and CDK/CASCADE (which don't).

### Writing a good `group_smarts`

- Anchor on the atom you actually want. `[CH2][OH]` scores the **CH2** carbon
  (or its protons), not the O or its H.
- Make it specific enough to match exactly one chemical environment. If a
  pattern matches two environments with different real shifts, you'll bake error
  into the reference. Prefer omitting an ambiguous assignment over guessing.
- Aromatic atoms are lowercase (`[cH]`, `[cH0]`, `n`, `o`). `[cH0]` is a
  substituted/ring-fusion aromatic carbon with no H.
- Validate after editing: `python -m benchmarks.cli --validate-dataset`. This
  confirms every molecule canonicalizes and every pattern matches >= 1 atom of
  the right element.

## Fields

| Field | Meaning |
| --- | --- |
| `id` | unique slug |
| `name` | display name |
| `smiles` | input SMILES (canonicalized before use) |
| `scenario` | bucket: `aliphatic`, `aromatic`, `carbonyl`, `carboxylic_acid`, `heteroatom_halogen`, `conjugated_strained`, `larger` |
| `heavy_atoms` | optional, informational (the harness recomputes it) |
| `solvent` | solvent the reference value was measured in |
| `source` | provenance of the numbers |
| `shifts.<nucleus>[]` | list of `{group_smarts, ppm, exchangeable?}` |

`exchangeable: true` flags OH/NH/COOH protons whose experimental shift is
strongly solvent/concentration dependent. They can be dropped from `1H` metrics
with `--exclude-exchangeable`.

## A note on accuracy of the reference values

These are standard textbook/database values (SDBS, Pretsch *Structure
Determination of Organic Compounds*, nmrshiftdb2), good to roughly +/-0.5 ppm
(`1H`) and +/-2 ppm (`13C`). They are fit for ranking engines and tracking
regressions, not for certifying absolute accuracy. The `larger` bucket
deliberately carries only a few unambiguous assignments per molecule — its
purpose is to exercise ORCA's cost scaling, not to fully assign big spectra.
