namespace kmod_replay {

static auto replay_sample_interval_ms(int32_t sample_hz) -> uint64_t {
    if (sample_hz <= 0) {
        sample_hz = 60;
    }
    return static_cast<uint64_t>(1000 / sample_hz);
}

static auto replay_sampler_reset(ReplaySamplerState& sampler, uint64_t now_ms) -> void {
    sampler.next_sample_ms = now_ms;
    sampler.last_sample_ms = 0;
    sampler.sample_hz = 60;
}

static auto replay_sampler_update_hz(ReplaySamplerState& sampler, uint64_t now_ms) -> void {
    if (sampler.last_sample_ms == 0) {
        return;
    }

    const uint64_t dt_ms = now_ms - sampler.last_sample_ms;
    int32_t next_hz = 60;
    if (dt_ms > 34) {
        next_hz = 30;
    } else if (dt_ms > 23) {
        next_hz = 45;
    }

    sampler.sample_hz = next_hz;
}

static auto replay_sampler_should_sample(ReplaySamplerState& sampler, uint64_t now_ms) -> bool {
    if (sampler.next_sample_ms == 0) {
        replay_sampler_reset(sampler, now_ms);
    }
    if (now_ms < sampler.next_sample_ms) {
        return false;
    }

    replay_sampler_update_hz(sampler, now_ms);
    sampler.last_sample_ms = now_ms;
    sampler.next_sample_ms = now_ms + replay_sample_interval_ms(sampler.sample_hz);
    return true;
}

} // namespace kmod_replay
