#!/bin/bash
# Confirms the GPU memory sizes the dashboard shows (the "gpus" table in
# sites/hakusan.json) on the real cards: one 5-minute job per GPU partition
# runs nvidia-smi, then a TINY job — after all of them, whatever their outcome —
# writes ~/hm-gpu-mem/conclusion.md on hakusan. The GPU jobs wait in the queue
# until a card is free; nothing needs to stay connected.
#
#   scripts/probe_gpu_memory.sh            submit
#   scripts/probe_gpu_memory.sh --result   print the conclusion (or the queue)
set -eu
HOST=${HM_PROBE_HOST:-s2510082@hakusan2}
DIR=hm-gpu-mem
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST")

if [ "${1:-}" = "--result" ]; then
  "${SSH[@]}" "cat ~/$DIR/conclusion.md 2>/dev/null || { echo 'not finished yet:'; squeue -h -u \$USER -n hm-gpumem,hm-gpumem-conclude -o '%i %j %P %T %r %S'; }"
  exit 0
fi

# partition : model : GB the catalog states (keep in step with the site file's "gpus")
PROBES=("GPU-1:A40:48" "GPU-1A:A100:40")

"${SSH[@]}" "mkdir -p ~/$DIR"
scp -q -o BatchMode=yes "$(dirname "$0")/gpu_memory_conclude.sh" "$HOST:$DIR/conclude.sh"

specs=()
ids=()
for p in "${PROBES[@]}"; do
  part=${p%%:*}
  id=$("${SSH[@]}" "sbatch --parsable -p $part -t 5 -J hm-gpumem -o ~/$DIR/$part.out \
        --wrap 'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader; hostname'")
  id=${id%%;*}
  echo "submitted $part as job $id"
  specs+=("$p:$id")
  ids+=("$id")
done
dep=$(IFS=:; echo "${ids[*]}")
quoted=$(printf "'%s' " "${specs[@]}")
cid=$("${SSH[@]}" "sbatch --parsable -p TINY -t 5 -J hm-gpumem-conclude --dependency=afterany:$dep \
       -o ~/$DIR/conclude.log --wrap \"bash ~/$DIR/conclude.sh ~/$DIR $quoted\"")
echo "conclusion job ${cid%%;*} runs after $dep; read it with: $0 --result"
