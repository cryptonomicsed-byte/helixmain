(ns helix.policy.request
  "Validation of `helix-policy-request/1`.

  The request is untrusted input: it is built by the kernel from an intent an
  agent proposed, and its `arguments` carry whatever a model or a customer
  wrote. Nothing in here is ever evaluated or used as policy. This namespace
  only answers \"is it shaped the way the contract says\", and it returns every
  problem it finds as a plain string so a denial can say why.")

(def format-id "helix-policy-request/1")
(def risks #{"low" "medium" "high"})
(def principal-kinds #{"user" "service" "agent"})
(def confirmation-kinds #{"user_confirmation" "human_review"})

(def ^:private max-string 4096)
(def ^:private max-capabilities 256)

(defn- nonblank? [v] (and (string? v) (not= "" v) (<= (count v) max-string)))
(defn- short-string? [v] (and (string? v) (<= (count v) max-string)))

(defn- check [problems ok? message]
  (if ok? problems (conj problems message)))

(defn problems
  "A vector of strings, empty when the request is valid."
  [req]
  (if-not (map? req)
    ["request must be a JSON object"]
    (let [principal (get req "principal")
          agent (get req "agent")
          intent (get req "intent")
          confirmation (get req "confirmation")]
      (cond-> []
        true (check (= format-id (get req "format")) (str "format must be " format-id))
        true (check (nonblank? (get req "now")) "now is required")
        true (check (nonblank? (get req "organization_id")) "organization_id is required")

        true (check (map? principal) "principal is required")
        (map? principal) (check (nonblank? (get principal "id")) "principal.id is required")
        (map? principal) (check (contains? principal-kinds (get principal "kind")) "principal.kind must be user, service or agent")

        true (check (map? agent) "agent is required")
        (map? agent) (check (nonblank? (get agent "sid")) "agent.sid is required")
        (map? agent) (check (nonblank? (get agent "status")) "agent.status is required")
        (map? agent) (check (and (sequential? (get agent "capabilities"))
                                 (<= (count (get agent "capabilities")) max-capabilities)
                                 (every? nonblank? (get agent "capabilities")))
                            "agent.capabilities must be a list of strings")

        true (check (map? intent) "intent is required")
        (map? intent) (check (nonblank? (get intent "id")) "intent.id is required")
        (map? intent) (check (nonblank? (get intent "capability")) "intent.capability is required")
        (map? intent) (check (short-string? (get intent "tool")) "intent.tool must be a string")
        (map? intent) (check (short-string? (get intent "target")) "intent.target must be a string")
        (map? intent) (check (short-string? (get intent "operation")) "intent.operation must be a string")
        (map? intent) (check (contains? risks (get intent "risk")) "intent.risk must be low, medium or high")
        (map? intent) (check (let [a (get intent "amount_minor")]
                               (and (integer? a) (<= 0 a Long/MAX_VALUE)))
                             "intent.amount_minor must be a non-negative integer")
        (map? intent) (check (short-string? (get intent "currency")) "intent.currency must be a string")
        (map? intent) (check (short-string? (get intent "audience")) "intent.audience must be a string")
        (map? intent) (check (map? (get intent "arguments")) "intent.arguments must be an object")
        ;; Money needs a currency: an amount without one cannot be limited.
        (and (map? intent) (integer? (get intent "amount_minor")) (pos? (get intent "amount_minor")))
        (check (nonblank? (get intent "currency")) "intent.currency is required when money moves")

        (some? confirmation) (check (map? confirmation) "confirmation must be an object")
        (map? confirmation) (check (nonblank? (get confirmation "by")) "confirmation.by is required")
        (map? confirmation) (check (contains? confirmation-kinds (get confirmation "kind"))
                                   "confirmation.kind must be user_confirmation or human_review")))))
