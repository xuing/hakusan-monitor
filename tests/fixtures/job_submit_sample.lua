-- Synthetic job_submit.lua written for tests in the same shape as the
-- cluster's plugin (the real file is read from the cluster at runtime and is
-- not stored in this repository). Comments deliberately disagree with code.
function slurm_job_submit(job_desc, part_list, submit_uid)
--    if job_desc.script == nil or job_desc.script == "" then
--        local max_time = 9999
--    end

    -- CPU partition: defaults, no interactive rule (honors -t)
    if (job_desc.partition == "CPU-T") then
        if (job_desc.num_tasks == slurm.NO_VAL or job_desc.num_tasks == 0) then
            job_desc.num_tasks = 16
        end
        if (job_desc.min_cpus == slurm.NO_VAL or job_desc.min_cpus == 0) then
            job_desc.min_cpus = 16
            job_desc.cpus_per_task = 16
        end

    -- CPU partition with an interactive limit; the comment says 12 hours
    elseif (job_desc.partition == "CPU-I") then
        if (job_desc.min_cpus == slurm.NO_VAL or job_desc.min_cpus == 0) then
            job_desc.min_cpus = 256
        end
        if job_desc.script == nil or job_desc.script == "" then
            -- 12 hours
            local max_time = 2880
            job_desc.time_limit = max_time
            return slurm.SUCCESS
        end

    -- GPU partition that still honours --gres (pre-2026-06-11 shape)
    elseif (job_desc.partition == "GPU-OLD") then
        local has_gpu = false
        if job_desc.gres ~= nil then
            has_gpu = true
        end
        if job_desc.gpus ~= nil then
            has_gpu = true
        end
        if not has_gpu then
            job_desc.gres = "gpu:1"
        end

    -- GPU partition whose check misses --gres (current shape)
    elseif (job_desc.partition == "GPU-NEW") then
        if (job_desc.min_cpus == slurm.NO_VAL or job_desc.min_cpus == 0) then
            job_desc.min_cpus = 26
        end
        local has_gpu = false
        if job_desc.gpus ~= nil then
            has_gpu = true
        end
        if job_desc.gpus_per_node ~= nil then
            has_gpu = true
        end
        if not has_gpu then
            job_desc.gres = "gpu:1"
        end
        if job_desc.script == nil or job_desc.script == "" then
            local max_time = 720
            job_desc.time_limit = max_time
            return slurm.SUCCESS
        end

    elseif (job_desc.partition == "LIC") then
        if (job_desc.licenses == nil or job_desc.licenses == "") then
            return slurm.ERROR
        end

    elseif (job_desc.partition == "LICDEF") then
        -- fills the license instead of rejecting
        if (job_desc.licenses == nil or job_desc.licenses == "") then
	    job_desc.licenses = "ms_castep@lmgr:1"
        end
    end
    return slurm.SUCCESS
end

function slurm_job_modify(job_desc, job_submit_info, submit_uid)
    if (job_desc.partition == "IGNORED") then
        job_desc.num_tasks = 1
    end
    return slurm.SUCCESS
end
