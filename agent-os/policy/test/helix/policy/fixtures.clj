(ns helix.policy.fixtures
  (:require [helix.policy.rules :as rules]))

(def default-policy (rules/load-file* "policies/helix-default.edn"))

(defn req
  "A valid request; `overrides` is a map of path-vector -> value."
  ([] (req {}))
  ([overrides]
   (reduce (fn [r [path v]] (assoc-in r path v))
           {"format" "helix-policy-request/1"
            "now" "2026-11-15T10:00:00Z"
            "organization_id" "org_acme"
            "principal" {"id" "user_ada" "kind" "user"}
            "agent" {"sid" "sid_support" "status" "live" "capabilities" ["kb.search" "call.transfer" "merchant.checkout" "policy.update"]}
            "intent" {"id" "int_1" "capability" "kb.search" "tool" "kb.search" "target" "kb:main"
                      "operation" "kb.search" "risk" "low" "amount_minor" 0 "currency" ""
                      "audience" "executor_1" "arguments" {"q" "opening hours"}}}
           overrides)))

(defn with-confirmation [r kind & [by]]
  (assoc r "confirmation" {"by" (or by (get-in r ["principal" "id"])) "kind" kind}))

(defn policy-of [& rule-maps]
  (rules/load-string* (pr-str {:id "t" :rules (vec rule-maps)})))

(defn rule [id decision code when]
  {:id id :decision decision :reason-code code :when when})
