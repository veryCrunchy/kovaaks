std::string sanitize_state_request_reason(std::string value) {
    std::string out;
    out.reserve(value.size());
    for (char ch : value) {
        const unsigned char uch = static_cast<unsigned char>(ch);
        if (std::isalnum(uch) || ch == '_' || ch == '-' || ch == ':' || ch == '.') {
            out.push_back(ch);
        }
    }
    if (out.empty()) {
        return "unknown";
    }
    return out;
}

bool consume_state_snapshot_request(std::string& out_reason) {
    out_reason = "unknown";
    const std::wstring path = game_bin_dir() + L"kovaaks_request_state.flag";
    const auto fs_path = std::filesystem::path(path);
    if (!std::filesystem::exists(fs_path)) {
        return false;
    }

    std::ifstream in(fs_path);
    if (in.is_open()) {
        std::string line;
        while (std::getline(in, line)) {
            if (line.rfind("reason=", 0) == 0) {
                out_reason = line.substr(7);
                break;
            }
            if (!line.empty() && out_reason == "unknown") {
                out_reason = line;
            }
        }
    }

    out_reason = sanitize_state_request_reason(out_reason);
    std::error_code ec;
    std::filesystem::remove(fs_path, ec);
    return true;
}
