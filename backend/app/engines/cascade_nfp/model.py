"""Rebuild CASCADE's DFTNN graph neural network in Keras 3.

Architecture mirrors ``graph_network.py`` in the upstream repo's
``code/predicting_model/{C,H}/DFTNN/`` exactly, with layers
named so the shipped Keras 2 HDF5 weights load by name via
``model.load_weights(path)``.
"""
from __future__ import annotations

import logging

try:
    from absl import logging as absl_logging
except ImportError:
    absl_logging = None
else:
    absl_logging.set_verbosity(absl_logging.ERROR)
    absl_logging.set_stderrthreshold("error")

logging.getLogger("tensorflow").setLevel(logging.ERROR)

import keras

from .layers import GatherAtomToBond, ReduceAtomToPro, ReduceBondToAtom, Squeeze


ATOM_FEATURES = 256
RBF_DIM = 256
N_MESSAGE_BLOCKS = 3


def build_cascade_model(atom_classes: int) -> keras.Model:
    """Functional model matching upstream weight layout.

    ``atom_classes`` is the preprocessor's ``atom_classes`` (vocab
    size + 1 for the null slot). The shipped DFTNN weights use 10.
    """
    atom_index = keras.Input(shape=(1,), dtype="int32", name="atom_index")
    atom = keras.Input(shape=(1,), dtype="int32", name="atom")
    distance_rbf = keras.Input(shape=(RBF_DIM,), dtype="float32", name="distance_rbf")
    connectivity = keras.Input(shape=(2,), dtype="int32", name="connectivity")
    n_pro = keras.Input(shape=(1,), dtype="int32", name="n_pro")

    # Upstream reuses a single Squeeze instance across all three scalar
    # inputs; keep the same single layer so weight counts line up.
    squeeze = Squeeze(name="squeeze_1")
    s_atom_index = squeeze(atom_index)
    s_atom_types = squeeze(atom)
    s_n_pro = squeeze(n_pro)

    atom_state = keras.layers.Embedding(
        atom_classes, ATOM_FEATURES, name="atom_embedding"
    )(s_atom_types)
    atomwise_shift = keras.layers.Embedding(
        atom_classes, 1, name="atomwise_shift"
    )(s_atom_types)

    bond_state = distance_rbf

    # Running counters — upstream relied on Keras 2 auto-naming
    # (dense_1, dense_2, ...). Name explicitly so Keras 3 matches the
    # HDF5 weight layout regardless of how auto-naming evolved.
    dense_n = 1
    gather_n = 1
    reduce_bond_n = 1
    concat_n = 1
    mul_n = 1
    add_n = 1

    def dense(units, activation=None, use_bias=True):
        nonlocal dense_n
        layer = keras.layers.Dense(
            units, activation=activation, use_bias=use_bias, name=f"dense_{dense_n}"
        )
        dense_n += 1
        return layer

    for _ in range(N_MESSAGE_BLOCKS):
        atom_state = dense(ATOM_FEATURES, use_bias=False)(atom_state)

        source_atom = GatherAtomToBond(1, name=f"gather_atom_to_bond_{gather_n}")(
            [atom_state, connectivity]
        )
        gather_n += 1
        target_atom = GatherAtomToBond(0, name=f"gather_atom_to_bond_{gather_n}")(
            [atom_state, connectivity]
        )
        gather_n += 1

        bond_state_message = keras.layers.Concatenate(name=f"concatenate_{concat_n}")(
            [source_atom, target_atom, bond_state]
        )
        concat_n += 1
        bond_state_message = dense(2 * ATOM_FEATURES, activation="softplus")(bond_state_message)
        bond_state_message = dense(ATOM_FEATURES)(bond_state_message)
        bond_state_message = dense(ATOM_FEATURES, activation="softplus")(bond_state_message)
        bond_state_message = dense(ATOM_FEATURES, activation="softplus")(bond_state_message)
        bond_state = keras.layers.Add(name=f"add_{add_n}")([bond_state_message, bond_state])
        add_n += 1

        messages = keras.layers.Multiply(name=f"multiply_{mul_n}")([source_atom, bond_state])
        mul_n += 1
        messages = ReduceBondToAtom(
            reducer="sum", name=f"reduce_bond_to_atom_{reduce_bond_n}"
        )([messages, connectivity])
        reduce_bond_n += 1
        messages = dense(ATOM_FEATURES, activation="softplus")(messages)
        messages = dense(ATOM_FEATURES)(messages)
        atom_state = keras.layers.Add(name=f"add_{add_n}")([atom_state, messages])
        add_n += 1

    atom_state = ReduceAtomToPro(
        reducer="unsorted_mean", name="reduce_atom_to_pro_1"
    )([atom_state, s_atom_index, s_n_pro])
    atomwise_shift = ReduceAtomToPro(
        reducer="unsorted_mean", name="reduce_atom_to_pro_2"
    )([atomwise_shift, s_atom_index, s_n_pro])

    atom_state = dense(ATOM_FEATURES, activation="softplus")(atom_state)
    atom_state = dense(ATOM_FEATURES, activation="softplus")(atom_state)
    atom_state = dense(ATOM_FEATURES // 2, activation="softplus")(atom_state)
    atom_state = dense(1)(atom_state)

    output = keras.layers.Add(name=f"add_{add_n}")([atom_state, atomwise_shift])

    return keras.Model(
        inputs=[atom_index, atom, distance_rbf, connectivity, n_pro],
        outputs=output,
        name="cascade_dftnn",
    )
