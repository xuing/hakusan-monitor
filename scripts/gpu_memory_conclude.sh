#!/bin/bash
# Runs on hakusan as the last job of probe_gpu_memory.sh: reads what
# nvidia-smi reported in each GPU partition and writes conclusion.md next to
# it, comparing against the memory backend/normalize.py's GPU_CATALOG shows.
#
# Usage (by the probe, not by hand): gpu_memory_conclude.sh DIR "PART:LABEL:GB:JOBID" ...
set -u
dir="$1"; shift
out="$dir/conclusion.md"
{
  echo "# GPU memory probe — $(date '+%Y-%m-%d %H:%M %Z')"
  echo
  echo "nvidia-smi \`memory.total\` inside one job per partition, against GPU_CATALOG in backend/normalize.py."
  echo "A card reports a little less than its nominal size (ECC / driver reserve): A40 48 GB shows 46068 MiB."
  echo
  echo "| partition | model in catalog | catalog GB | nvidia-smi name | memory.total | job state | verdict |"
  echo "|---|---|---|---|---|---|---|"
  for spec in "$@"; do
    IFS=: read -r part label gb jobid <<<"$spec"
    state=$(sacct -n -X -j "$jobid" -o State%20 2>/dev/null | awk 'NR==1{print $1}')
    line=$(grep -m1 -i "nvidia" "$dir/$part.out" 2>/dev/null)
    name=$(echo "$line" | cut -d, -f1 | xargs)
    mib=$(echo "$line" | cut -d, -f2 | grep -oE '[0-9]+')
    if [ -z "$mib" ]; then
      verdict="no reading (see $part.out)"
    else
      # a reading between 90% and 100% of the nominal size is that size
      lo=$((gb * 1024 * 90 / 100)); hi=$((gb * 1024))
      if [ "$mib" -ge "$lo" ] && [ "$mib" -le "$hi" ]; then verdict="matches ${gb} GB"
      else verdict="MISMATCH: ${mib} MiB is not ${gb} GB — fix GPU_CATALOG"; fi
    fi
    echo "| $part | $label | $gb | ${name:-—} | ${mib:+$mib MiB} | ${state:-unknown} | $verdict |"
  done
  echo
  echo "H100 MIG (h100-20c) is not probed: every node of that pool was down when this ran."
} >"$out"
