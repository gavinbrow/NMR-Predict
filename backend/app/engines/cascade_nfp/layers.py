"""Keras 3 port of CASCADE's `nfp.layers`.

Every op goes through `keras.ops` rather than raw `tf.*` so the model
can run on any Keras 3 backend. Layer names match the originals so
``load_weights`` against the legacy HDF5 files lines up by name.

The CASCADE DFTNN architecture uses only a subset of the upstream
`nfp.layers` module: Squeeze, GatherAtomToBond, ReduceBondToAtom,
ReduceAtomToPro. The matrix-multiplication MessageLayer / Embedding2D /
EdgeNetwork variants belong to a different nfp model and aren't ported.
"""
from __future__ import annotations

import keras
from keras import ops


class Squeeze(keras.layers.Layer):
    """Drop the trailing size-1 axis Keras adds to scalar-per-row inputs."""

    def call(self, inputs):
        return ops.squeeze(inputs, axis=1)

    def compute_output_shape(self, input_shape):
        return input_shape[:-1]


class GatherAtomToBond(keras.layers.Layer):
    """Reindex an atom matrix onto bonds using one column of connectivity.

    ``index=0`` picks the receiving atom; ``index=1`` picks the sending atom.
    Matches Gilmer 2017 edge-update conventions used by CASCADE.
    """

    def __init__(self, index, **kwargs):
        super().__init__(**kwargs)
        self.index = index

    def call(self, inputs):
        atom_matrix, connectivity = inputs
        return ops.take(atom_matrix, connectivity[:, self.index], axis=0)

    def compute_output_shape(self, input_shape):
        return input_shape[0]

    def get_config(self):
        config = super().get_config()
        config["index"] = self.index
        return config


def _segment_mean(data, segment_ids, num_segments, sorted_):
    summed = ops.segment_sum(data, segment_ids, num_segments=num_segments, sorted=sorted_)
    ones = ops.ones_like(segment_ids, dtype=summed.dtype)
    count = ops.segment_sum(ones, segment_ids, num_segments=num_segments, sorted=sorted_)
    # Avoid division by zero for empty segments.
    count = ops.where(ops.equal(count, 0), ops.ones_like(count), count)
    count = ops.reshape(count, (-1, 1))
    return summed / count


class _Reducer(keras.layers.Layer):
    """Shared config/plumbing for segment-reduction layers.

    CASCADE uses ``reducer='sum'`` (ReduceBondToAtom, sorted) and
    ``reducer='unsorted_mean'`` (ReduceAtomToPro). We support the
    handful of variants the upstream module defines even if the
    DFTNN model itself only picks two.
    """

    _VALID = {"sum", "mean", "unsorted_sum", "unsorted_mean", "max", "min"}

    def __init__(self, reducer=None, **kwargs):
        super().__init__(**kwargs)
        if reducer is None:
            reducer = "sum"
        if reducer not in self._VALID:
            raise ValueError(f"Unknown reducer: {reducer!r}")
        self.reducer = reducer

    def _reduce(self, data, segment_ids, num_segments=None):
        sorted_ = self.reducer not in ("unsorted_sum", "unsorted_mean")
        if self.reducer in ("mean", "unsorted_mean"):
            return _segment_mean(data, segment_ids, num_segments, sorted_)
        if self.reducer == "max":
            return ops.segment_max(data, segment_ids, num_segments=num_segments, sorted=sorted_)
        if self.reducer == "min":
            return -ops.segment_max(-data, segment_ids, num_segments=num_segments, sorted=sorted_)
        # sum / unsorted_sum
        return ops.segment_sum(data, segment_ids, num_segments=num_segments, sorted=sorted_)

    def compute_output_shape(self, input_shape):
        return input_shape[0]

    def get_config(self):
        config = super().get_config()
        config["reducer"] = self.reducer
        return config


class ReduceBondToAtom(_Reducer):
    """Aggregate messages arriving at each receiving atom (sorted sum)."""

    def call(self, inputs):
        bond_matrix, connectivity = inputs
        return self._reduce(bond_matrix, connectivity[:, 0])


class ReduceAtomToPro(_Reducer):
    """Aggregate atom features into per-target-atom output slots.

    ``atom_index`` maps each atom to a global target slot (or is
    pre-offset to an unused slot by the preprocessor for atoms we
    don't predict on). ``n_pro`` is the per-molecule count of target
    atoms; its sum bounds the number of output slots.
    """

    def call(self, inputs):
        atom_matrix, atom_index, n_pro = inputs
        num_segments = ops.cast(ops.sum(n_pro), "int32")
        return self._reduce(atom_matrix, atom_index, num_segments=num_segments)
