(ns runner
  (:require [clojure.test :as t]))

(def namespaces '[helix.policy.lang-test helix.policy.rules-test helix.policy.core-test helix.policy.server-test])

(defn -main [& _]
  (doseq [n namespaces] (require n))
  (let [{:keys [fail error test pass]} (apply t/run-tests namespaces)]
    (println (format "policy: %d tests, %d assertions, %d failures, %d errors" test (+ pass fail error) fail error))
    (System/exit (if (zero? (+ fail error)) 0 1))))
