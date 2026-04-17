"""CASCADE — ported `nfp` package (Keras 2 -> Keras 3).

The upstream CASCADE repo (patonlab/CASCADE) was written against
Keras 2.2 / TensorFlow 1.12. This package re-implements the pieces we
need (custom layers, feature tokenizer, preprocessor, graph sequence)
against Keras 3 + numpy + RDKit so we can load the shipped HDF5
weights on a modern stack.
"""
