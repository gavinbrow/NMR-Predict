# NMR Predict — Accuracy Benchmark

_Generated 2026-05-25T16:12:03_

## Run coverage

| Label | Nucleus | ok | skipped | error |
| --- | --- | --- | --- | --- |
| cascade | 13C | 39 | 0 | 0 |
| cascade | 1H | 38 | 0 | 0 |
| cdk | 13C | 35 | 0 | 0 |
| cdk | 1H | 38 | 0 | 0 |
| orca [B3LYP/pcSseg-1] | 13C | 38 | 0 | 0 |
| orca [B3LYP/pcSseg-1] | 1H | 37 | 0 | 0 |
| orca [B3LYP/pcSseg-2] | 13C | 38 | 0 | 0 |
| orca [B3LYP/pcSseg-2] | 1H | 37 | 0 | 0 |
| orca [B97-D3/def2-TZVP] | 13C | 39 | 0 | 0 |
| orca [B97-D3/def2-TZVP] | 1H | 38 | 0 | 0 |
| orca [PBE/def2-SVP] | 13C | 39 | 0 | 0 |
| orca [PBE/def2-SVP] | 1H | 38 | 0 | 0 |
| orca [PBE0/def2-TZVP] | 13C | 39 | 0 | 0 |
| orca [PBE0/def2-TZVP] | 1H | 38 | 0 | 0 |
| orca [PBE0/pcSseg-1] | 13C | 38 | 0 | 1 |
| orca [PBE0/pcSseg-1] | 1H | 37 | 0 | 1 |
| orca [TPSS/def2-SVP] | 13C | 39 | 0 | 0 |
| orca [TPSS/def2-SVP] | 1H | 38 | 0 | 0 |
| orca [TPSSh/pcSseg-1] | 13C | 38 | 0 | 1 |
| orca [TPSSh/pcSseg-1] | 1H | 37 | 0 | 1 |
| orca [r2SCAN/pcSseg-1] | 13C | 38 | 0 | 1 |
| orca [r2SCAN/pcSseg-1] | 1H | 37 | 0 | 1 |
| orca [wB97X-D3/def2-TZVP] | 13C | 39 | 0 | 0 |
| orca [wB97X-D3/def2-TZVP] | 1H | 38 | 0 | 0 |
| orca [wB97X-D3/pcSseg-1] | 13C | 38 | 0 | 1 |
| orca [wB97X-D3/pcSseg-1] | 1H | 37 | 0 | 1 |

## Overall accuracy

| Label | Nucleus | n | MAE | RMSE | Max err | Bias | R² | Scaled MAE | Total s | s/heavy atom |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cascade | 13C | 70 | 1.742 | 4.553 | 32.686 | 0.377 | 0.995 | 2.037 | 5.703 | 0.021 |
| cascade | 1H | 63 | 0.893 | 2.011 | 7.837 | -0.171 | 0.621 | 0.963 | 2.874 | 0.011 |
| cdk | 13C | 66 | 3.057 | 5.981 | 33.189 | -0.433 | 0.990 | 3.418 | 0.101 | 0.000 |
| cdk | 1H | 63 | 0.627 | 1.203 | 4.847 | 0.304 | 0.864 | 0.659 | 0.064 | 0.000 |
| orca [B3LYP/pcSseg-1] | 13C | 69 | 6.524 | 8.113 | 31.527 | 6.431 | 0.982 | 2.524 | 448.201 | 1.679 |
| orca [B3LYP/pcSseg-1] | 1H | 62 | 0.670 | 1.436 | 5.541 | -0.437 | 0.808 | 0.865 | 429.471 | 1.678 |
| orca [B3LYP/pcSseg-2] | 13C | 69 | 9.545 | 11.232 | 33.257 | 9.416 | 0.966 | 2.488 | 1030.375 | 3.859 |
| orca [B3LYP/pcSseg-2] | 1H | 62 | 0.694 | 1.374 | 5.334 | -0.314 | 0.824 | 0.826 | 966.428 | 3.775 |
| orca [B97-D3/def2-TZVP] | 13C | 70 | 4.333 | 6.916 | 34.476 | 2.765 | 0.988 | 3.895 | 453.633 | 1.686 |
| orca [B97-D3/def2-TZVP] | 1H | 63 | 0.764 | 1.528 | 5.838 | -0.390 | 0.781 | 0.915 | 429.425 | 1.664 |
| orca [PBE/def2-SVP] | 13C | 70 | 4.469 | 7.057 | 30.860 | -1.168 | 0.987 | 3.706 | 235.162 | 0.874 |
| orca [PBE/def2-SVP] | 1H | 63 | 0.783 | 1.663 | 6.234 | -0.684 | 0.740 | 0.967 | 227.443 | 0.882 |
| orca [PBE0/def2-TZVP] | 13C | 70 | 6.034 | 7.751 | 26.976 | 5.888 | 0.985 | 2.671 | 786.165 | 2.923 |
| orca [PBE0/def2-TZVP] | 1H | 63 | 0.761 | 1.500 | 5.678 | -0.381 | 0.789 | 0.890 | 758.390 | 2.939 |
| orca [PBE0/pcSseg-1] | 13C | 69 | 5.632 | 7.233 | 27.296 | 5.554 | 0.986 | 2.388 | 448.171 | 1.666 |
| orca [PBE0/pcSseg-1] | 1H | 62 | 0.689 | 1.426 | 5.439 | -0.406 | 0.810 | 0.858 | 425.385 | 1.649 |
| orca [TPSS/def2-SVP] | 13C | 70 | 5.246 | 7.773 | 29.583 | -2.487 | 0.984 | 3.521 | 306.960 | 1.141 |
| orca [TPSS/def2-SVP] | 1H | 63 | 0.728 | 1.595 | 6.049 | -0.687 | 0.761 | 0.924 | 295.662 | 1.146 |
| orca [TPSSh/pcSseg-1] | 13C | 69 | 3.737 | 5.418 | 28.830 | 3.254 | 0.992 | 2.509 | 495.834 | 1.843 |
| orca [TPSSh/pcSseg-1] | 1H | 62 | 0.658 | 1.415 | 5.443 | -0.431 | 0.813 | 0.856 | 474.422 | 1.839 |
| orca [r2SCAN/pcSseg-1] | 13C | 69 | 4.920 | 6.705 | 33.752 | 4.459 | 0.988 | 2.962 | 348.377 | 1.295 |
| orca [r2SCAN/pcSseg-1] | 1H | 62 | 0.709 | 1.415 | 5.413 | -0.333 | 0.813 | 0.859 | 334.137 | 1.295 |
| orca [wB97X-D3/def2-TZVP] | 13C | 70 | 6.096 | 7.617 | 21.660 | 5.992 | 0.985 | 2.414 | 1021.079 | 3.796 |
| orca [wB97X-D3/def2-TZVP] | 1H | 63 | 0.742 | 1.477 | 5.599 | -0.385 | 0.795 | 0.872 | 982.364 | 3.808 |
| orca [wB97X-D3/pcSseg-1] | 13C | 69 | 5.815 | 7.304 | 21.271 | 5.769 | 0.986 | 2.269 | 560.079 | 2.082 |
| orca [wB97X-D3/pcSseg-1] | 1H | 62 | 0.691 | 1.414 | 5.376 | -0.419 | 0.814 | 0.845 | 537.919 | 2.085 |

_Scaled MAE = MAE after a least-squares linear correction (removes systematic bias; rewards levels that are linear-but-offset)._

## Per-scenario accuracy

| Label | Nucleus | Scenario | n | MAE | RMSE | Max err | Bias |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cascade | 13C | aliphatic | 11 | 0.718 | 0.936 | 1.997 | 0.378 |
| cascade | 13C | aromatic | 13 | 0.358 | 0.514 | 1.410 | 0.289 |
| cascade | 13C | carbonyl | 10 | 0.831 | 1.207 | 2.604 | -0.779 |
| cascade | 13C | carboxylic_acid | 4 | 3.695 | 4.248 | 5.383 | -3.695 |
| cascade | 13C | conjugated_strained | 7 | 1.070 | 1.264 | 2.415 | 0.667 |
| cascade | 13C | heteroatom_halogen | 7 | 7.777 | 13.456 | 32.686 | 6.764 |
| cascade | 13C | larger | 18 | 1.353 | 2.010 | 5.320 | -0.610 |
| cascade | 1H | aliphatic | 12 | 0.519 | 0.902 | 2.245 | 0.485 |
| cascade | 1H | aromatic | 10 | 0.087 | 0.152 | 0.457 | -0.030 |
| cascade | 1H | carbonyl | 8 | 0.232 | 0.310 | 0.663 | -0.162 |
| cascade | 1H | carboxylic_acid | 5 | 4.176 | 5.320 | 7.837 | -4.176 |
| cascade | 1H | conjugated_strained | 6 | 0.202 | 0.308 | 0.689 | 0.173 |
| cascade | 1H | heteroatom_halogen | 7 | 1.097 | 1.667 | 4.063 | 0.403 |
| cascade | 1H | larger | 15 | 1.171 | 2.345 | 7.023 | 0.134 |
| cdk | 13C | aliphatic | 10 | 3.939 | 6.321 | 13.630 | 1.929 |
| cdk | 13C | aromatic | 13 | 3.569 | 4.931 | 12.281 | -3.110 |
| cdk | 13C | carbonyl | 10 | 0.465 | 0.738 | 1.954 | -0.085 |
| cdk | 13C | carboxylic_acid | 4 | 3.037 | 3.792 | 5.782 | -3.037 |
| cdk | 13C | conjugated_strained | 7 | 7.627 | 13.225 | 33.189 | 4.027 |
| cdk | 13C | heteroatom_halogen | 4 | 0.375 | 0.541 | 1.000 | -0.325 |
| cdk | 13C | larger | 18 | 2.461 | 4.455 | 13.399 | -1.183 |
| cdk | 1H | aliphatic | 12 | 0.924 | 1.455 | 4.243 | 0.924 |
| cdk | 1H | aromatic | 10 | 0.160 | 0.281 | 0.812 | 0.122 |
| cdk | 1H | carbonyl | 8 | 0.120 | 0.141 | 0.257 | 0.035 |
| cdk | 1H | carboxylic_acid | 5 | 1.019 | 1.880 | 4.153 | -0.670 |
| cdk | 1H | conjugated_strained | 6 | 0.564 | 0.860 | 1.865 | 0.523 |
| cdk | 1H | heteroatom_halogen | 7 | 1.266 | 2.139 | 4.847 | 0.225 |
| cdk | 1H | larger | 15 | 0.569 | 0.843 | 1.849 | 0.348 |
| orca [B3LYP/pcSseg-1] | 13C | aliphatic | 11 | 3.339 | 3.712 | 6.240 | 2.864 |
| orca [B3LYP/pcSseg-1] | 13C | aromatic | 13 | 6.618 | 7.139 | 10.977 | 6.618 |
| orca [B3LYP/pcSseg-1] | 13C | carbonyl | 10 | 6.671 | 7.798 | 12.896 | 6.671 |
| orca [B3LYP/pcSseg-1] | 13C | carboxylic_acid | 4 | 2.146 | 2.493 | 3.982 | 1.841 |
| orca [B3LYP/pcSseg-1] | 13C | conjugated_strained | 7 | 7.792 | 8.886 | 13.232 | 7.792 |
| orca [B3LYP/pcSseg-1] | 13C | heteroatom_halogen | 6 | 10.233 | 14.868 | 31.527 | 10.233 |
| orca [B3LYP/pcSseg-1] | 13C | larger | 18 | 7.566 | 8.218 | 14.952 | 7.566 |
| orca [B3LYP/pcSseg-1] | 1H | aliphatic | 12 | 0.555 | 0.961 | 2.018 | -0.408 |
| orca [B3LYP/pcSseg-1] | 1H | aromatic | 10 | 0.186 | 0.210 | 0.298 | 0.180 |
| orca [B3LYP/pcSseg-1] | 1H | carbonyl | 8 | 0.098 | 0.123 | 0.271 | 0.040 |
| orca [B3LYP/pcSseg-1] | 1H | carboxylic_acid | 5 | 3.038 | 3.895 | 5.541 | -3.028 |
| orca [B3LYP/pcSseg-1] | 1H | conjugated_strained | 6 | 0.285 | 0.321 | 0.461 | 0.126 |
| orca [B3LYP/pcSseg-1] | 1H | heteroatom_halogen | 6 | 0.561 | 0.939 | 2.234 | -0.333 |
| orca [B3LYP/pcSseg-1] | 1H | larger | 15 | 0.797 | 1.517 | 5.201 | -0.531 |
| orca [B3LYP/pcSseg-2] | 13C | aliphatic | 11 | 4.798 | 5.310 | 8.391 | 4.106 |
| orca [B3LYP/pcSseg-2] | 13C | aromatic | 13 | 10.323 | 10.950 | 15.552 | 10.323 |
| orca [B3LYP/pcSseg-2] | 13C | carbonyl | 10 | 10.128 | 12.280 | 20.244 | 10.128 |
| orca [B3LYP/pcSseg-2] | 13C | carboxylic_acid | 4 | 5.960 | 6.748 | 8.376 | 5.637 |
| orca [B3LYP/pcSseg-2] | 13C | conjugated_strained | 7 | 10.043 | 11.487 | 17.586 | 10.043 |
| orca [B3LYP/pcSseg-2] | 13C | heteroatom_halogen | 6 | 11.350 | 15.799 | 33.257 | 11.350 |
| orca [B3LYP/pcSseg-2] | 13C | larger | 18 | 11.560 | 12.303 | 22.050 | 11.560 |
| orca [B3LYP/pcSseg-2] | 1H | aliphatic | 12 | 0.494 | 0.862 | 1.828 | -0.358 |
| orca [B3LYP/pcSseg-2] | 1H | aromatic | 10 | 0.326 | 0.347 | 0.457 | 0.326 |
| orca [B3LYP/pcSseg-2] | 1H | carbonyl | 8 | 0.204 | 0.302 | 0.594 | 0.186 |
| orca [B3LYP/pcSseg-2] | 1H | carboxylic_acid | 5 | 2.897 | 3.718 | 5.334 | -2.833 |
| orca [B3LYP/pcSseg-2] | 1H | conjugated_strained | 6 | 0.418 | 0.466 | 0.678 | 0.245 |
| orca [B3LYP/pcSseg-2] | 1H | heteroatom_halogen | 6 | 0.556 | 0.838 | 1.943 | -0.238 |
| orca [B3LYP/pcSseg-2] | 1H | larger | 15 | 0.792 | 1.451 | 5.002 | -0.386 |
| orca [B97-D3/def2-TZVP] | 13C | aliphatic | 11 | 3.977 | 4.767 | 7.616 | 3.346 |
| orca [B97-D3/def2-TZVP] | 13C | aromatic | 13 | 1.972 | 2.286 | 3.672 | 0.583 |
| orca [B97-D3/def2-TZVP] | 13C | carbonyl | 10 | 2.717 | 3.156 | 5.000 | 1.921 |
| orca [B97-D3/def2-TZVP] | 13C | carboxylic_acid | 4 | 4.681 | 4.985 | 6.404 | -4.681 |
| orca [B97-D3/def2-TZVP] | 13C | conjugated_strained | 7 | 2.792 | 3.467 | 6.481 | 1.328 |
| orca [B97-D3/def2-TZVP] | 13C | heteroatom_halogen | 7 | 13.369 | 18.243 | 34.476 | 12.329 |
| orca [B97-D3/def2-TZVP] | 13C | larger | 18 | 4.164 | 4.816 | 8.277 | 2.947 |
| orca [B97-D3/def2-TZVP] | 1H | aliphatic | 12 | 0.624 | 1.075 | 2.294 | -0.439 |
| orca [B97-D3/def2-TZVP] | 1H | aromatic | 10 | 0.239 | 0.268 | 0.390 | 0.239 |
| orca [B97-D3/def2-TZVP] | 1H | carbonyl | 8 | 0.244 | 0.387 | 0.785 | 0.223 |
| orca [B97-D3/def2-TZVP] | 1H | carboxylic_acid | 5 | 3.193 | 4.094 | 5.838 | -3.142 |
| orca [B97-D3/def2-TZVP] | 1H | conjugated_strained | 6 | 0.361 | 0.409 | 0.620 | 0.188 |
| orca [B97-D3/def2-TZVP] | 1H | heteroatom_halogen | 7 | 0.661 | 1.016 | 2.493 | -0.225 |
| orca [B97-D3/def2-TZVP] | 1H | larger | 15 | 0.904 | 1.617 | 5.430 | -0.488 |
| orca [PBE/def2-SVP] | 13C | aliphatic | 11 | 1.555 | 1.748 | 3.429 | 0.655 |
| orca [PBE/def2-SVP] | 13C | aromatic | 13 | 3.691 | 4.253 | 8.669 | -2.992 |
| orca [PBE/def2-SVP] | 13C | carbonyl | 10 | 3.225 | 4.529 | 11.678 | -2.832 |
| orca [PBE/def2-SVP] | 13C | carboxylic_acid | 4 | 11.453 | 12.217 | 14.503 | -11.453 |
| orca [PBE/def2-SVP] | 13C | conjugated_strained | 7 | 2.953 | 3.514 | 6.045 | -1.360 |
| orca [PBE/def2-SVP] | 13C | heteroatom_halogen | 7 | 12.193 | 16.619 | 30.860 | 8.730 |
| orca [PBE/def2-SVP] | 13C | larger | 18 | 3.538 | 4.686 | 10.814 | -1.528 |
| orca [PBE/def2-SVP] | 1H | aliphatic | 12 | 0.702 | 1.282 | 2.680 | -0.644 |
| orca [PBE/def2-SVP] | 1H | aromatic | 10 | 0.091 | 0.122 | 0.274 | -0.031 |
| orca [PBE/def2-SVP] | 1H | carbonyl | 8 | 0.223 | 0.234 | 0.332 | -0.122 |
| orca [PBE/def2-SVP] | 1H | carboxylic_acid | 5 | 3.568 | 4.415 | 6.234 | -3.568 |
| orca [PBE/def2-SVP] | 1H | conjugated_strained | 6 | 0.299 | 0.391 | 0.828 | -0.104 |
| orca [PBE/def2-SVP] | 1H | heteroatom_halogen | 7 | 0.687 | 1.155 | 2.921 | -0.560 |
| orca [PBE/def2-SVP] | 1H | larger | 15 | 0.916 | 1.756 | 5.746 | -0.780 |
| orca [PBE0/def2-TZVP] | 13C | aliphatic | 11 | 2.625 | 3.022 | 4.819 | 1.931 |
| orca [PBE0/def2-TZVP] | 13C | aromatic | 13 | 6.052 | 6.571 | 10.190 | 6.052 |
| orca [PBE0/def2-TZVP] | 13C | carbonyl | 10 | 6.265 | 7.683 | 12.522 | 6.265 |
| orca [PBE0/def2-TZVP] | 13C | carboxylic_acid | 4 | 2.102 | 2.370 | 3.732 | 1.457 |
| orca [PBE0/def2-TZVP] | 13C | conjugated_strained | 7 | 6.974 | 7.924 | 12.297 | 6.974 |
| orca [PBE0/def2-TZVP] | 13C | heteroatom_halogen | 7 | 10.878 | 14.848 | 26.976 | 10.878 |
| orca [PBE0/def2-TZVP] | 13C | larger | 18 | 6.600 | 7.255 | 13.189 | 6.600 |
| orca [PBE0/def2-TZVP] | 1H | aliphatic | 12 | 0.559 | 1.055 | 2.275 | -0.503 |
| orca [PBE0/def2-TZVP] | 1H | aromatic | 10 | 0.392 | 0.424 | 0.555 | 0.392 |
| orca [PBE0/def2-TZVP] | 1H | carbonyl | 8 | 0.216 | 0.318 | 0.615 | 0.151 |
| orca [PBE0/def2-TZVP] | 1H | carboxylic_acid | 5 | 3.113 | 4.000 | 5.678 | -3.089 |
| orca [PBE0/def2-TZVP] | 1H | conjugated_strained | 6 | 0.429 | 0.480 | 0.744 | 0.272 |
| orca [PBE0/def2-TZVP] | 1H | heteroatom_halogen | 7 | 0.549 | 0.934 | 2.392 | -0.358 |
| orca [PBE0/def2-TZVP] | 1H | larger | 15 | 0.907 | 1.597 | 5.326 | -0.449 |
| orca [PBE0/pcSseg-1] | 13C | aliphatic | 11 | 1.978 | 2.352 | 4.194 | 1.594 |
| orca [PBE0/pcSseg-1] | 13C | aromatic | 13 | 5.966 | 6.552 | 10.448 | 5.966 |
| orca [PBE0/pcSseg-1] | 13C | carbonyl | 10 | 6.151 | 7.305 | 11.850 | 6.151 |
| orca [PBE0/pcSseg-1] | 13C | carboxylic_acid | 4 | 1.693 | 2.218 | 4.048 | 1.412 |
| orca [PBE0/pcSseg-1] | 13C | conjugated_strained | 7 | 8.124 | 8.959 | 12.361 | 8.124 |
| orca [PBE0/pcSseg-1] | 13C | heteroatom_halogen | 6 | 9.018 | 12.853 | 27.296 | 9.018 |
| orca [PBE0/pcSseg-1] | 13C | larger | 18 | 6.113 | 7.010 | 12.855 | 6.113 |
| orca [PBE0/pcSseg-1] | 1H | aliphatic | 12 | 0.545 | 0.964 | 2.049 | -0.440 |
| orca [PBE0/pcSseg-1] | 1H | aromatic | 10 | 0.291 | 0.316 | 0.448 | 0.291 |
| orca [PBE0/pcSseg-1] | 1H | carbonyl | 8 | 0.105 | 0.135 | 0.272 | 0.044 |
| orca [PBE0/pcSseg-1] | 1H | carboxylic_acid | 5 | 2.996 | 3.839 | 5.439 | -2.985 |
| orca [PBE0/pcSseg-1] | 1H | conjugated_strained | 6 | 0.342 | 0.378 | 0.511 | 0.203 |
| orca [PBE0/pcSseg-1] | 1H | heteroatom_halogen | 6 | 0.519 | 0.929 | 2.231 | -0.369 |
| orca [PBE0/pcSseg-1] | 1H | larger | 15 | 0.819 | 1.507 | 5.141 | -0.481 |
| orca [TPSS/def2-SVP] | 13C | aliphatic | 11 | 1.015 | 1.647 | 4.735 | 0.445 |
| orca [TPSS/def2-SVP] | 13C | aromatic | 13 | 5.773 | 6.260 | 10.846 | -5.018 |
| orca [TPSS/def2-SVP] | 13C | carbonyl | 10 | 4.138 | 5.645 | 12.545 | -3.817 |
| orca [TPSS/def2-SVP] | 13C | carboxylic_acid | 4 | 11.638 | 12.605 | 14.841 | -11.638 |
| orca [TPSS/def2-SVP] | 13C | conjugated_strained | 7 | 4.704 | 5.305 | 8.509 | -3.856 |
| orca [TPSS/def2-SVP] | 13C | heteroatom_halogen | 7 | 12.016 | 16.726 | 29.583 | 8.606 |
| orca [TPSS/def2-SVP] | 13C | larger | 18 | 4.222 | 5.681 | 11.421 | -3.459 |
| orca [TPSS/def2-SVP] | 1H | aliphatic | 12 | 0.654 | 1.205 | 2.519 | -0.621 |
| orca [TPSS/def2-SVP] | 1H | aromatic | 10 | 0.088 | 0.147 | 0.343 | -0.086 |
| orca [TPSS/def2-SVP] | 1H | carbonyl | 8 | 0.203 | 0.239 | 0.461 | -0.203 |
| orca [TPSS/def2-SVP] | 1H | carboxylic_acid | 5 | 3.457 | 4.280 | 6.049 | -3.457 |
| orca [TPSS/def2-SVP] | 1H | conjugated_strained | 6 | 0.210 | 0.290 | 0.634 | -0.138 |
| orca [TPSS/def2-SVP] | 1H | heteroatom_halogen | 7 | 0.604 | 1.054 | 2.683 | -0.518 |
| orca [TPSS/def2-SVP] | 1H | larger | 15 | 0.850 | 1.681 | 5.580 | -0.775 |
| orca [TPSSh/pcSseg-1] | 13C | aliphatic | 11 | 2.257 | 2.820 | 5.715 | 2.172 |
| orca [TPSSh/pcSseg-1] | 13C | aromatic | 13 | 2.954 | 3.236 | 5.412 | 2.327 |
| orca [TPSSh/pcSseg-1] | 13C | carbonyl | 10 | 3.530 | 4.159 | 7.691 | 3.530 |
| orca [TPSSh/pcSseg-1] | 13C | carboxylic_acid | 4 | 1.738 | 2.080 | 3.208 | -1.738 |
| orca [TPSSh/pcSseg-1] | 13C | conjugated_strained | 7 | 4.232 | 4.770 | 7.464 | 3.967 |
| orca [TPSSh/pcSseg-1] | 13C | heteroatom_halogen | 6 | 8.979 | 13.556 | 28.830 | 8.979 |
| orca [TPSSh/pcSseg-1] | 13C | larger | 18 | 3.827 | 4.407 | 8.338 | 3.354 |
| orca [TPSSh/pcSseg-1] | 1H | aliphatic | 12 | 0.549 | 0.956 | 2.016 | -0.417 |
| orca [TPSSh/pcSseg-1] | 1H | aromatic | 10 | 0.187 | 0.209 | 0.296 | 0.176 |
| orca [TPSSh/pcSseg-1] | 1H | carbonyl | 8 | 0.091 | 0.103 | 0.185 | 0.018 |
| orca [TPSSh/pcSseg-1] | 1H | carboxylic_acid | 5 | 2.992 | 3.834 | 5.443 | -2.975 |
| orca [TPSSh/pcSseg-1] | 1H | conjugated_strained | 6 | 0.234 | 0.258 | 0.320 | 0.129 |
| orca [TPSSh/pcSseg-1] | 1H | heteroatom_halogen | 6 | 0.559 | 0.936 | 2.227 | -0.317 |
| orca [TPSSh/pcSseg-1] | 1H | larger | 15 | 0.793 | 1.493 | 5.122 | -0.509 |
| orca [r2SCAN/pcSseg-1] | 13C | aliphatic | 11 | 4.167 | 4.734 | 7.427 | 4.048 |
| orca [r2SCAN/pcSseg-1] | 13C | aromatic | 13 | 3.604 | 3.900 | 6.076 | 3.045 |
| orca [r2SCAN/pcSseg-1] | 13C | carbonyl | 10 | 4.044 | 4.461 | 6.790 | 4.002 |
| orca [r2SCAN/pcSseg-1] | 13C | carboxylic_acid | 4 | 2.043 | 2.523 | 3.826 | -1.907 |
| orca [r2SCAN/pcSseg-1] | 13C | conjugated_strained | 7 | 5.915 | 6.485 | 9.770 | 5.915 |
| orca [r2SCAN/pcSseg-1] | 13C | heteroatom_halogen | 6 | 11.246 | 16.194 | 33.752 | 11.246 |
| orca [r2SCAN/pcSseg-1] | 13C | larger | 18 | 4.961 | 5.604 | 8.959 | 4.569 |
| orca [r2SCAN/pcSseg-1] | 1H | aliphatic | 12 | 0.546 | 0.920 | 1.943 | -0.363 |
| orca [r2SCAN/pcSseg-1] | 1H | aromatic | 10 | 0.306 | 0.330 | 0.482 | 0.306 |
| orca [r2SCAN/pcSseg-1] | 1H | carbonyl | 8 | 0.136 | 0.192 | 0.423 | 0.125 |
| orca [r2SCAN/pcSseg-1] | 1H | carboxylic_acid | 5 | 2.970 | 3.817 | 5.413 | -2.937 |
| orca [r2SCAN/pcSseg-1] | 1H | conjugated_strained | 6 | 0.345 | 0.391 | 0.536 | 0.267 |
| orca [r2SCAN/pcSseg-1] | 1H | heteroatom_halogen | 6 | 0.626 | 0.949 | 2.179 | -0.203 |
| orca [r2SCAN/pcSseg-1] | 1H | larger | 15 | 0.838 | 1.491 | 5.110 | -0.402 |
| orca [wB97X-D3/def2-TZVP] | 13C | aliphatic | 11 | 2.026 | 2.323 | 3.905 | 1.478 |
| orca [wB97X-D3/def2-TZVP] | 13C | aromatic | 13 | 6.878 | 7.515 | 11.223 | 6.878 |
| orca [wB97X-D3/def2-TZVP] | 13C | carbonyl | 10 | 6.711 | 8.159 | 12.510 | 6.711 |
| orca [wB97X-D3/def2-TZVP] | 13C | carboxylic_acid | 4 | 2.597 | 2.943 | 4.392 | 2.293 |
| orca [wB97X-D3/def2-TZVP] | 13C | conjugated_strained | 7 | 7.556 | 8.426 | 12.227 | 7.556 |
| orca [wB97X-D3/def2-TZVP] | 13C | heteroatom_halogen | 7 | 9.241 | 12.335 | 21.660 | 9.241 |
| orca [wB97X-D3/def2-TZVP] | 13C | larger | 18 | 6.664 | 7.473 | 13.465 | 6.664 |
| orca [wB97X-D3/def2-TZVP] | 1H | aliphatic | 12 | 0.546 | 1.020 | 2.220 | -0.492 |
| orca [wB97X-D3/def2-TZVP] | 1H | aromatic | 10 | 0.408 | 0.445 | 0.580 | 0.408 |
| orca [wB97X-D3/def2-TZVP] | 1H | carbonyl | 8 | 0.192 | 0.273 | 0.540 | 0.120 |
| orca [wB97X-D3/def2-TZVP] | 1H | carboxylic_acid | 5 | 3.074 | 3.961 | 5.599 | -3.067 |
| orca [wB97X-D3/def2-TZVP] | 1H | conjugated_strained | 6 | 0.417 | 0.470 | 0.717 | 0.301 |
| orca [wB97X-D3/def2-TZVP] | 1H | heteroatom_halogen | 7 | 0.498 | 0.891 | 2.284 | -0.451 |
| orca [wB97X-D3/def2-TZVP] | 1H | larger | 15 | 0.880 | 1.571 | 5.283 | -0.449 |
| orca [wB97X-D3/pcSseg-1] | 13C | aliphatic | 11 | 1.415 | 1.817 | 4.050 | 1.128 |
| orca [wB97X-D3/pcSseg-1] | 13C | aromatic | 13 | 6.751 | 7.407 | 11.529 | 6.751 |
| orca [wB97X-D3/pcSseg-1] | 13C | carbonyl | 10 | 6.850 | 8.111 | 12.629 | 6.850 |
| orca [wB97X-D3/pcSseg-1] | 13C | carboxylic_acid | 4 | 2.575 | 3.143 | 5.254 | 2.575 |
| orca [wB97X-D3/pcSseg-1] | 13C | conjugated_strained | 7 | 8.789 | 9.558 | 12.658 | 8.789 |
| orca [wB97X-D3/pcSseg-1] | 13C | heteroatom_halogen | 6 | 7.681 | 10.213 | 21.271 | 7.681 |
| orca [wB97X-D3/pcSseg-1] | 13C | larger | 18 | 6.194 | 7.336 | 13.470 | 6.194 |
| orca [wB97X-D3/pcSseg-1] | 1H | aliphatic | 12 | 0.555 | 0.953 | 2.046 | -0.447 |
| orca [wB97X-D3/pcSseg-1] | 1H | aromatic | 10 | 0.308 | 0.337 | 0.475 | 0.308 |
| orca [wB97X-D3/pcSseg-1] | 1H | carbonyl | 8 | 0.091 | 0.104 | 0.195 | 0.001 |
| orca [wB97X-D3/pcSseg-1] | 1H | carboxylic_acid | 5 | 2.989 | 3.812 | 5.376 | -2.978 |
| orca [wB97X-D3/pcSseg-1] | 1H | conjugated_strained | 6 | 0.327 | 0.365 | 0.520 | 0.223 |
| orca [wB97X-D3/pcSseg-1] | 1H | heteroatom_halogen | 6 | 0.535 | 0.909 | 2.175 | -0.464 |
| orca [wB97X-D3/pcSseg-1] | 1H | larger | 15 | 0.816 | 1.493 | 5.111 | -0.490 |

## Per-size accuracy and speed

| Label | Nucleus | Size bucket | n | MAE | RMSE | Total s | s/heavy atom |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cascade | 13C | tiny (1-3 heavy atoms) | 15 | 3.545 | 8.643 | 3.130 | 0.108 |
| cascade | 13C | small (4-7 heavy atoms) | 24 | 1.403 | 3.085 | 0.124 | 0.002 |
| cascade | 13C | medium (8-14 heavy atoms) | 22 | 0.792 | 1.331 | 0.466 | 0.004 |
| cascade | 13C | large (15+ heavy atoms) | 9 | 1.960 | 2.648 | 1.983 | 0.031 |
| cascade | 1H | tiny (1-3 heavy atoms) | 17 | 1.019 | 1.799 | 0.360 | 0.012 |
| cascade | 1H | small (4-7 heavy atoms) | 22 | 0.619 | 1.746 | 0.122 | 0.002 |
| cascade | 1H | medium (8-14 heavy atoms) | 16 | 0.626 | 1.819 | 0.398 | 0.004 |
| cascade | 1H | large (15+ heavy atoms) | 8 | 1.915 | 3.157 | 1.994 | 0.031 |
| cdk | 13C | tiny (1-3 heavy atoms) | 12 | 5.784 | 10.924 | 0.005 | 0.000 |
| cdk | 13C | small (4-7 heavy atoms) | 23 | 2.064 | 4.125 | 0.019 | 0.000 |
| cdk | 13C | medium (8-14 heavy atoms) | 22 | 3.685 | 4.932 | 0.056 | 0.000 |
| cdk | 13C | large (15+ heavy atoms) | 9 | 0.425 | 0.562 | 0.021 | 0.000 |
| cdk | 1H | tiny (1-3 heavy atoms) | 17 | 1.167 | 1.965 | 0.007 | 0.000 |
| cdk | 1H | small (4-7 heavy atoms) | 22 | 0.409 | 0.789 | 0.015 | 0.000 |
| cdk | 1H | medium (8-14 heavy atoms) | 16 | 0.437 | 0.689 | 0.016 | 0.000 |
| cdk | 1H | large (15+ heavy atoms) | 8 | 0.462 | 0.726 | 0.026 | 0.000 |
| orca [B3LYP/pcSseg-1] | 13C | tiny (1-3 heavy atoms) | 14 | 5.276 | 6.952 | 41.328 | 1.531 |
| orca [B3LYP/pcSseg-1] | 13C | small (4-7 heavy atoms) | 24 | 6.178 | 8.761 | 89.449 | 1.398 |
| orca [B3LYP/pcSseg-1] | 13C | medium (8-14 heavy atoms) | 22 | 7.046 | 7.871 | 154.476 | 1.379 |
| orca [B3LYP/pcSseg-1] | 13C | large (15+ heavy atoms) | 9 | 8.115 | 8.563 | 162.947 | 2.546 |
| orca [B3LYP/pcSseg-1] | 1H | tiny (1-3 heavy atoms) | 16 | 0.701 | 1.345 | 40.512 | 1.500 |
| orca [B3LYP/pcSseg-1] | 1H | small (4-7 heavy atoms) | 22 | 0.502 | 1.230 | 89.138 | 1.393 |
| orca [B3LYP/pcSseg-1] | 1H | medium (8-14 heavy atoms) | 16 | 0.689 | 1.509 | 136.416 | 1.351 |
| orca [B3LYP/pcSseg-1] | 1H | large (15+ heavy atoms) | 8 | 1.032 | 1.912 | 163.405 | 2.553 |
| orca [B3LYP/pcSseg-2] | 13C | tiny (1-3 heavy atoms) | 14 | 6.867 | 8.872 | 57.129 | 2.116 |
| orca [B3LYP/pcSseg-2] | 13C | small (4-7 heavy atoms) | 24 | 8.872 | 11.389 | 147.968 | 2.312 |
| orca [B3LYP/pcSseg-2] | 13C | medium (8-14 heavy atoms) | 22 | 10.916 | 11.737 | 339.506 | 3.031 |
| orca [B3LYP/pcSseg-2] | 13C | large (15+ heavy atoms) | 9 | 12.154 | 12.734 | 485.772 | 7.590 |
| orca [B3LYP/pcSseg-2] | 1H | tiny (1-3 heavy atoms) | 16 | 0.683 | 1.262 | 57.040 | 2.113 |
| orca [B3LYP/pcSseg-2] | 1H | small (4-7 heavy atoms) | 22 | 0.529 | 1.169 | 147.132 | 2.299 |
| orca [B3LYP/pcSseg-2] | 1H | medium (8-14 heavy atoms) | 16 | 0.775 | 1.472 | 289.679 | 2.868 |
| orca [B3LYP/pcSseg-2] | 1H | large (15+ heavy atoms) | 8 | 1.008 | 1.832 | 472.575 | 7.384 |
| orca [B97-D3/def2-TZVP] | 13C | tiny (1-3 heavy atoms) | 15 | 6.202 | 9.337 | 40.850 | 1.409 |
| orca [B97-D3/def2-TZVP] | 13C | small (4-7 heavy atoms) | 24 | 4.274 | 7.872 | 77.321 | 1.208 |
| orca [B97-D3/def2-TZVP] | 13C | medium (8-14 heavy atoms) | 22 | 3.171 | 3.907 | 164.669 | 1.470 |
| orca [B97-D3/def2-TZVP] | 13C | large (15+ heavy atoms) | 9 | 4.219 | 4.916 | 170.793 | 2.669 |
| orca [B97-D3/def2-TZVP] | 1H | tiny (1-3 heavy atoms) | 17 | 0.765 | 1.428 | 39.830 | 1.373 |
| orca [B97-D3/def2-TZVP] | 1H | small (4-7 heavy atoms) | 22 | 0.586 | 1.311 | 77.901 | 1.217 |
| orca [B97-D3/def2-TZVP] | 1H | medium (8-14 heavy atoms) | 16 | 0.791 | 1.609 | 145.817 | 1.444 |
| orca [B97-D3/def2-TZVP] | 1H | large (15+ heavy atoms) | 8 | 1.200 | 2.035 | 165.877 | 2.592 |
| orca [PBE/def2-SVP] | 13C | tiny (1-3 heavy atoms) | 15 | 5.943 | 9.117 | 22.242 | 0.767 |
| orca [PBE/def2-SVP] | 13C | small (4-7 heavy atoms) | 24 | 4.595 | 7.933 | 45.325 | 0.708 |
| orca [PBE/def2-SVP] | 13C | medium (8-14 heavy atoms) | 22 | 3.554 | 4.795 | 85.724 | 0.765 |
| orca [PBE/def2-SVP] | 13C | large (15+ heavy atoms) | 9 | 3.916 | 4.977 | 81.870 | 1.279 |
| orca [PBE/def2-SVP] | 1H | tiny (1-3 heavy atoms) | 17 | 0.846 | 1.580 | 22.218 | 0.766 |
| orca [PBE/def2-SVP] | 1H | small (4-7 heavy atoms) | 22 | 0.647 | 1.456 | 45.689 | 0.714 |
| orca [PBE/def2-SVP] | 1H | medium (8-14 heavy atoms) | 16 | 0.700 | 1.723 | 75.560 | 0.748 |
| orca [PBE/def2-SVP] | 1H | large (15+ heavy atoms) | 8 | 1.185 | 2.172 | 83.977 | 1.312 |
| orca [PBE0/def2-TZVP] | 13C | tiny (1-3 heavy atoms) | 15 | 6.122 | 8.713 | 58.696 | 2.024 |
| orca [PBE0/def2-TZVP] | 13C | small (4-7 heavy atoms) | 24 | 5.257 | 7.669 | 118.465 | 1.851 |
| orca [PBE0/def2-TZVP] | 13C | medium (8-14 heavy atoms) | 22 | 6.400 | 7.193 | 267.869 | 2.392 |
| orca [PBE0/def2-TZVP] | 13C | large (15+ heavy atoms) | 9 | 7.063 | 7.577 | 341.134 | 5.330 |
| orca [PBE0/def2-TZVP] | 1H | tiny (1-3 heavy atoms) | 17 | 0.705 | 1.387 | 58.668 | 2.023 |
| orca [PBE0/def2-TZVP] | 1H | small (4-7 heavy atoms) | 22 | 0.590 | 1.289 | 118.609 | 1.853 |
| orca [PBE0/def2-TZVP] | 1H | medium (8-14 heavy atoms) | 16 | 0.862 | 1.595 | 233.040 | 2.307 |
| orca [PBE0/def2-TZVP] | 1H | large (15+ heavy atoms) | 8 | 1.147 | 1.993 | 348.072 | 5.439 |
| orca [PBE0/pcSseg-1] | 13C | tiny (1-3 heavy atoms) | 14 | 5.101 | 6.518 | 45.662 | 1.575 |
| orca [PBE0/pcSseg-1] | 13C | small (4-7 heavy atoms) | 24 | 5.108 | 7.639 | 88.459 | 1.382 |
| orca [PBE0/pcSseg-1] | 13C | medium (8-14 heavy atoms) | 22 | 6.154 | 7.202 | 150.531 | 1.344 |
| orca [PBE0/pcSseg-1] | 13C | large (15+ heavy atoms) | 9 | 6.578 | 7.253 | 163.519 | 2.555 |
| orca [PBE0/pcSseg-1] | 1H | tiny (1-3 heavy atoms) | 16 | 0.680 | 1.336 | 42.790 | 1.476 |
| orca [PBE0/pcSseg-1] | 1H | small (4-7 heavy atoms) | 22 | 0.527 | 1.224 | 87.079 | 1.361 |
| orca [PBE0/pcSseg-1] | 1H | medium (8-14 heavy atoms) | 16 | 0.749 | 1.497 | 132.707 | 1.314 |
| orca [PBE0/pcSseg-1] | 1H | large (15+ heavy atoms) | 8 | 1.033 | 1.893 | 162.810 | 2.544 |
| orca [TPSS/def2-SVP] | 13C | tiny (1-3 heavy atoms) | 15 | 6.619 | 9.925 | 25.860 | 0.892 |
| orca [TPSS/def2-SVP] | 13C | small (4-7 heavy atoms) | 24 | 5.016 | 8.229 | 57.302 | 0.895 |
| orca [TPSS/def2-SVP] | 13C | medium (8-14 heavy atoms) | 22 | 5.063 | 6.115 | 111.593 | 0.996 |
| orca [TPSS/def2-SVP] | 13C | large (15+ heavy atoms) | 9 | 4.016 | 5.817 | 112.205 | 1.753 |
| orca [TPSS/def2-SVP] | 1H | tiny (1-3 heavy atoms) | 17 | 0.751 | 1.499 | 25.912 | 0.893 |
| orca [TPSS/def2-SVP] | 1H | small (4-7 heavy atoms) | 22 | 0.631 | 1.401 | 56.506 | 0.883 |
| orca [TPSS/def2-SVP] | 1H | medium (8-14 heavy atoms) | 16 | 0.652 | 1.658 | 98.434 | 0.975 |
| orca [TPSS/def2-SVP] | 1H | large (15+ heavy atoms) | 8 | 1.098 | 2.092 | 114.810 | 1.794 |
| orca [TPSSh/pcSseg-1] | 13C | tiny (1-3 heavy atoms) | 14 | 3.838 | 5.379 | 44.840 | 1.546 |
| orca [TPSSh/pcSseg-1] | 13C | small (4-7 heavy atoms) | 24 | 3.557 | 6.621 | 97.526 | 1.524 |
| orca [TPSSh/pcSseg-1] | 13C | medium (8-14 heavy atoms) | 22 | 3.801 | 4.132 | 171.518 | 1.531 |
| orca [TPSSh/pcSseg-1] | 13C | large (15+ heavy atoms) | 9 | 3.902 | 4.628 | 181.950 | 2.843 |
| orca [TPSSh/pcSseg-1] | 1H | tiny (1-3 heavy atoms) | 16 | 0.668 | 1.327 | 44.003 | 1.517 |
| orca [TPSSh/pcSseg-1] | 1H | small (4-7 heavy atoms) | 22 | 0.504 | 1.214 | 97.403 | 1.522 |
| orca [TPSSh/pcSseg-1] | 1H | medium (8-14 heavy atoms) | 16 | 0.676 | 1.481 | 151.743 | 1.502 |
| orca [TPSSh/pcSseg-1] | 1H | large (15+ heavy atoms) | 8 | 1.026 | 1.883 | 181.274 | 2.832 |
| orca [r2SCAN/pcSseg-1] | 13C | tiny (1-3 heavy atoms) | 14 | 5.162 | 6.902 | 36.978 | 1.275 |
| orca [r2SCAN/pcSseg-1] | 13C | small (4-7 heavy atoms) | 24 | 4.842 | 7.971 | 74.307 | 1.161 |
| orca [r2SCAN/pcSseg-1] | 13C | medium (8-14 heavy atoms) | 22 | 4.750 | 5.147 | 122.379 | 1.093 |
| orca [r2SCAN/pcSseg-1] | 13C | large (15+ heavy atoms) | 9 | 5.168 | 6.030 | 114.713 | 1.792 |
| orca [r2SCAN/pcSseg-1] | 1H | tiny (1-3 heavy atoms) | 16 | 0.696 | 1.320 | 36.279 | 1.251 |
| orca [r2SCAN/pcSseg-1] | 1H | small (4-7 heavy atoms) | 22 | 0.547 | 1.215 | 73.745 | 1.152 |
| orca [r2SCAN/pcSseg-1] | 1H | medium (8-14 heavy atoms) | 16 | 0.764 | 1.489 | 108.359 | 1.073 |
| orca [r2SCAN/pcSseg-1] | 1H | large (15+ heavy atoms) | 8 | 1.069 | 1.878 | 115.753 | 1.809 |
| orca [wB97X-D3/def2-TZVP] | 13C | tiny (1-3 heavy atoms) | 15 | 5.697 | 7.869 | 65.633 | 2.263 |
| orca [wB97X-D3/def2-TZVP] | 13C | small (4-7 heavy atoms) | 24 | 5.249 | 7.257 | 150.009 | 2.344 |
| orca [wB97X-D3/def2-TZVP] | 13C | medium (8-14 heavy atoms) | 22 | 6.968 | 7.851 | 347.613 | 3.104 |
| orca [wB97X-D3/def2-TZVP] | 13C | large (15+ heavy atoms) | 9 | 6.887 | 7.546 | 457.824 | 7.154 |
| orca [wB97X-D3/def2-TZVP] | 1H | tiny (1-3 heavy atoms) | 17 | 0.686 | 1.361 | 64.736 | 2.232 |
| orca [wB97X-D3/def2-TZVP] | 1H | small (4-7 heavy atoms) | 22 | 0.572 | 1.271 | 149.960 | 2.343 |
| orca [wB97X-D3/def2-TZVP] | 1H | medium (8-14 heavy atoms) | 16 | 0.857 | 1.571 | 307.027 | 3.040 |
| orca [wB97X-D3/def2-TZVP] | 1H | large (15+ heavy atoms) | 8 | 1.096 | 1.965 | 460.640 | 7.198 |
| orca [wB97X-D3/pcSseg-1] | 13C | tiny (1-3 heavy atoms) | 14 | 5.022 | 6.304 | 46.306 | 1.597 |
| orca [wB97X-D3/pcSseg-1] | 13C | small (4-7 heavy atoms) | 24 | 5.202 | 7.300 | 104.698 | 1.636 |
| orca [wB97X-D3/pcSseg-1] | 13C | medium (8-14 heavy atoms) | 22 | 6.724 | 7.868 | 196.463 | 1.754 |
| orca [wB97X-D3/pcSseg-1] | 13C | large (15+ heavy atoms) | 9 | 6.458 | 7.331 | 212.612 | 3.322 |
| orca [wB97X-D3/pcSseg-1] | 1H | tiny (1-3 heavy atoms) | 16 | 0.670 | 1.325 | 44.938 | 1.550 |
| orca [wB97X-D3/pcSseg-1] | 1H | small (4-7 heavy atoms) | 22 | 0.545 | 1.217 | 104.157 | 1.627 |
| orca [wB97X-D3/pcSseg-1] | 1H | medium (8-14 heavy atoms) | 16 | 0.754 | 1.481 | 172.678 | 1.710 |
| orca [wB97X-D3/pcSseg-1] | 1H | large (15+ heavy atoms) | 8 | 1.007 | 1.877 | 216.146 | 3.377 |

## Worst offenders (largest absolute errors)

| Label | Nucleus | Molecule | Group | Ref ppm | Pred ppm | Abs err |
| --- | --- | --- | --- | --- | --- | --- |
| orca [B97-D3/def2-TZVP] | 13C | chloroform | `[CX4H1](Cl)(Cl)Cl` | 77.700 | 112.176 | 34.476 |
| orca [r2SCAN/pcSseg-1] | 13C | chloroform | `[CX4H1](Cl)(Cl)Cl` | 77.700 | 111.452 | 33.752 |
| orca [B3LYP/pcSseg-2] | 13C | chloroform | `[CX4H1](Cl)(Cl)Cl` | 77.700 | 110.957 | 33.257 |
| cdk | 13C | cyclopropane | `[CH2]` | -2.800 | 30.389 | 33.189 |
| cascade | 13C | iodomethane | `[CH3]I` | -20.700 | 11.986 | 32.686 |
| orca [B3LYP/pcSseg-1] | 13C | chloroform | `[CX4H1](Cl)(Cl)Cl` | 77.700 | 109.227 | 31.527 |
| orca [PBE/def2-SVP] | 13C | chloroform | `[CX4H1](Cl)(Cl)Cl` | 77.700 | 108.560 | 30.860 |
| orca [TPSS/def2-SVP] | 13C | chloroform | `[CX4H1](Cl)(Cl)Cl` | 77.700 | 107.283 | 29.583 |
| orca [TPSSh/pcSseg-1] | 13C | chloroform | `[CX4H1](Cl)(Cl)Cl` | 77.700 | 106.530 | 28.830 |
| orca [TPSS/def2-SVP] | 13C | iodomethane | `[CH3]I` | -20.700 | 7.098 | 27.798 |
| orca [B97-D3/def2-TZVP] | 13C | iodomethane | `[CH3]I` | -20.700 | 6.775 | 27.475 |
| orca [PBE0/pcSseg-1] | 13C | chloroform | `[CX4H1](Cl)(Cl)Cl` | 77.700 | 104.996 | 27.296 |
| orca [PBE0/def2-TZVP] | 13C | chloroform | `[CX4H1](Cl)(Cl)Cl` | 77.700 | 104.676 | 26.976 |
| orca [PBE/def2-SVP] | 13C | iodomethane | `[CH3]I` | -20.700 | 5.208 | 25.908 |
| orca [PBE0/def2-TZVP] | 13C | iodomethane | `[CH3]I` | -20.700 | 3.887 | 24.587 |
