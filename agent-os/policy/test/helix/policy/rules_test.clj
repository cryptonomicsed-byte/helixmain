(ns helix.policy.rules-test
  (:require [clojure.test :refer [deftest is testing]]
            [helix.policy.rules :as rules]))

(defn bad [s] (try (rules/load-string* s) nil (catch clojure.lang.ExceptionInfo e (:problems (ex-data e)))))
(defn ok-rule [& kvs] (merge {:id "r" :decision :allow :reason-code "ok" :when [:always]} (apply hash-map kvs)))
(defn doc [& rs] (pr-str {:id "p" :rules (vec rs)}))

(deftest the-shipped-policy-is-valid
  (let [p (rules/load-file* "policies/helix-default.edn")]
    (is (= "helix-default" (:id p)))
    (is (re-matches #"helix-default@sha256:[0-9a-f]{16}" (:version p)))
    (is (= 6 (count (:rules p))))))

(deftest one-bad-rule-rejects-the-document
  (is (nil? (bad (doc (ok-rule)))))
  (doseq [[label d] {"unknown key in a rule" (doc (ok-rule :surprise 1))
                     "unknown top-level key" (pr-str {:id "p" :rules [] :imports ["x"]})
                     "bad decision" (doc (ok-rule :decision :maybe))
                     "decision as a string" (doc (ok-rule :decision "allow"))
                     "no reason code" (doc (dissoc (ok-rule) :reason-code))
                     "upper-case reason code" (doc (ok-rule :reason-code "OK"))
                     "no condition" (doc (dissoc (ok-rule) :when))
                     "bad condition" (doc (ok-rule :when [:launch-missiles]))
                     "duplicate ids" (doc (ok-rule) (ok-rule))
                     "rules not a vector" (pr-str {:id "p" :rules '(1)})
                     "no id" (pr-str {:rules []})
                     "not a map" "[1 2 3]"
                     "empty file" ""
                     "just a string" "\"allow\""}]
    (is (seq (bad d)) label)))

(deftest the-reader-cannot-run-code
  (doseq [s ["#=(java.lang.System/exit 7)"
             "{:id \"p\" :rules [] :x #=(java.lang.System/exit 7)}"
             "#inst \"2026-01-01\""
             "#java.io.File [\"/etc/passwd\"]"
             "#unknown/tag 1"
             "{:id \"p\" :rules [#=(+ 1 2)]}"]]
    (is (seq (bad s)) s))
  (is true "the JVM is still here"))

(deftest oversized-and-unreadable-input
  (is (seq (bad (str "{:id \"p\" :rules [] :description \"" (apply str (repeat 300000 "x")) "\"}"))))
  (is (seq (bad "{:id \"p\" :rules [")))
  (let [bs (byte-array [0xff 0xfe 0x00])]
    (is (thrown? clojure.lang.ExceptionInfo (rules/load-bytes bs)))))

(deftest rank-orders-strictness
  (is (< (rules/rank :allow) (rules/rank :require_user_confirmation) (rules/rank :require_human_review) (rules/rank :deny))))
