# orders.csv del dataset → el COPY de A y C (lab/load/load.sh): sin la cabecera y con cancel_reason
# al final, USER en las CANCELLED (como las heredadas en la migración 005) y vacío (NULL) en el resto.
BEGIN { FS = OFS = "," }
NR > 1 { print $0, ($8 == "CANCELLED" ? "USER" : "") }
