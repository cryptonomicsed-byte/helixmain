(ns helix.policy.core
  "The decision function. Pure: (policy, request) -> answer, no I/O, no clock,
  no randomness, so the same request against the same policy always yields the
  same answer and a decision can be replayed from the audit record.

  Order of authority:
    1. A malformed request is DENY. It is never repaired.
    2. Invariants in this file, which no policy file can relax: the agent must
       be live (sid status) and must have declared the capability, and only a person
       confirms.
    3. The rules in the policy document. The strictest matching decision wins
       (deny > require_human_review > require_user_confirmation > allow).
       If nothing matches, DENY: the policy lists what is permitted.
    4. When the request carries a `confirmation`, a person's yes satisfies a
       confirmation requirement and, if it was a review, a review requirement.
       It never overrides a deny."
  (:require [clojure.string :as str]
            [helix.policy.request :as request]
            [helix.policy.rules :as rules]))

(defn- answer
  ([decision matched codes reason version]
   (answer decision matched codes reason version []))
  ([decision matched codes reason version all-matched]
   {"decision" (name decision)
    "matched_rule" matched
    "reason_codes" (vec (distinct codes))
    "reason" reason
    "policy_version" version
    "matched_rules" (vec all-matched)}))

(defn- deny [version code reason]
  (answer :deny "" [code] reason version))

(defn- invariant-denials
  "Reasons the request is refused regardless of any rule."
  [req]
  (let [agent (get req "agent") intent (get req "intent")
        principal (get req "principal") confirmation (get req "confirmation")]
    (cond-> []
      (not= "live" (get agent "status"))
      (conj ["agent_not_live" (str "the agent's status is " (pr-str (get agent "status")) ", not live")])

      (not (some #(= (get intent "capability") %) (get agent "capabilities")))
      (conj ["capability_not_declared" (str "the agent has not declared " (pr-str (get intent "capability")))])

      (and confirmation (not= "user" (get principal "kind")))
      (conj ["confirmer_not_a_person" "only a person can confirm an action"])

      (and confirmation (not= (get confirmation "by") (get principal "id")))
      (conj ["confirmer_mismatch" "the confirmation is not from the authenticated person"]))))

(defn decide
  "Returns the answer as a string-keyed map ready to serialise."
  [policy req]
  (let [version (:version policy)
        bad (request/problems req)]
    (if (seq bad)
      (deny version "invalid_request" (str/join "; " bad))
      (let [inv (invariant-denials req)]
        (if (seq inv)
          (answer :deny "" (map first inv) (str/join "; " (map second inv)) version)
          (let [matched (filterv #((:test %) req) (:rules policy))]
            (if (empty? matched)
              (deny version "no_matching_rule" "no rule in the policy permits this action")
              (let [top (apply max-key #(rules/rank (:decision %)) (reverse matched))
                    ;; max-key returns the LAST maximal element; reversing makes
                    ;; that the first one in file order, so the result does not
                    ;; depend on how max-key breaks ties.
                    winners (filterv #(= (:decision top) (:decision %)) matched)
                    codes (map :reason-code winners)
                    ids (map :id matched)
                    reason (or (first (remove empty? (map :reason winners))) "")
                    conf (get req "confirmation")
                    kind (get conf "kind")]
                (cond
                  (and conf (= :require_user_confirmation (:decision top)))
                  (if (contains? #{"user_confirmation" "human_review"} kind)
                    (answer :allow (:id top) (conj (vec codes) "confirmed") reason version ids)
                    (answer :deny (:id top) ["confirmation_insufficient"] "the confirmation is not of a kind policy accepts" version ids))

                  (and conf (= :require_human_review (:decision top)))
                  (if (= "human_review" kind)
                    (answer :allow (:id top) (conj (vec codes) "reviewed") reason version ids)
                    (answer :deny (:id top) (conj (vec codes) "review_required") "this action needs a human review, not only a user confirmation" version ids))

                  :else
                  (answer (:decision top) (:id top) codes reason version ids))))))))))

(defn safe-decide
  "`decide`, but any exception is a DENY. The answer for a request that could
  not be evaluated is never a guess."
  [policy req]
  (try
    (decide policy req)
    (catch Throwable t
      (deny (:version policy) "policy_evaluation_error"
            (str "the request could not be evaluated: " (.getSimpleName (class t)))))))
