(ns helix.policy.rules
  "Loading and validating a policy document.

  A policy is EDN on disk, written and reviewed by the operator. It is the only
  source of rules. Nothing that arrives in a request, a CARD or a conversation
  is ever merged into it. Loading is strict: one bad rule rejects the whole
  document, because a half-loaded policy is a policy nobody reviewed."
  (:require [clojure.edn :as edn]
            [clojure.string :as str]
            [helix.policy.lang :as lang])
  (:import (java.nio.charset StandardCharsets)
           (java.security MessageDigest)))

(def decisions #{:allow :deny :require_user_confirmation :require_human_review})

(def rank
  "Strictness. When several rules match, the strictest decision wins."
  {:allow 0 :require_user_confirmation 1 :require_human_review 2 :deny 3})

(def ^:private max-bytes (* 256 1024))
(def ^:private max-rules 500)
(def ^:private code-re #"[a-z0-9][a-z0-9_.:\-]{0,63}")
(def ^:private id-re #"[a-z0-9][a-z0-9_.\-]{0,63}")

(defn sha256-hex [^bytes bs]
  (let [d (.digest (MessageDigest/getInstance "SHA-256") bs)]
    (apply str (map #(format "%02x" (bit-and % 0xff)) d))))

(defn- rule-problems [i rule]
  (let [at (str "rule #" (inc i) (when (map? rule) (when-let [id (:id rule)] (str " (" id ")"))))]
    (if-not (map? rule)
      [(str at ": must be a map")]
      (let [unknown (remove #{:id :description :decision :reason-code :reason :when} (keys rule))]
        (cond-> []
          (seq unknown) (conj (str at ": unknown key(s) " (pr-str (vec unknown))))
          (not (and (string? (:id rule)) (re-matches id-re (:id rule)))) (conj (str at ": :id must match " id-re))
          (not (contains? decisions (:decision rule))) (conj (str at ": :decision must be one of " (pr-str decisions)))
          (not (and (string? (:reason-code rule)) (re-matches code-re (:reason-code rule)))) (conj (str at ": :reason-code must match " code-re))
          (and (:reason rule) (not (and (string? (:reason rule)) (<= (count (:reason rule)) 512)))) (conj (str at ": :reason must be a string of at most 512 characters"))
          (not (contains? rule :when)) (conj (str at ": :when is required"))
          (contains? rule :when) (into (map #(str at ": " %) (lang/validate-cond (:when rule)))))))))

(defn problems
  "[] when the document is a valid policy."
  [doc]
  (if-not (map? doc)
    ["a policy must be a map"]
    (let [rules (:rules doc)
          unknown (remove #{:id :description :rules} (keys doc))]
      (cond-> []
        (seq unknown) (conj (str "unknown top-level key(s) " (pr-str (vec unknown))))
        (not (and (string? (:id doc)) (re-matches id-re (:id doc)))) (conj (str ":id must match " id-re))
        (not (and (vector? rules) (<= (count rules) max-rules))) (conj (str ":rules must be a vector of at most " max-rules " rules"))
        (vector? rules) (into (mapcat rule-problems (range) rules))
        (and (vector? rules) (not= (count rules) (count (set (map :id rules))))) (conj "rule ids must be unique")))))

(defn compile-policy
  "Validated document + the bytes it came from -> an immutable runtime policy."
  [doc ^bytes bs]
  (let [ps (problems doc)]
    (when (seq ps)
      (throw (ex-info "invalid policy" {:problems ps})))
    {:id (:id doc)
     :version (str (:id doc) "@sha256:" (subs (sha256-hex bs) 0 16))
     :sha256 (sha256-hex bs)
     :rules (mapv (fn [r] {:id (:id r)
                           :decision (:decision r)
                           :reason-code (:reason-code r)
                           :reason (or (:reason r) (:description r) "")
                           :test (lang/compile-cond (:when r))})
                  (:rules doc))}))

(defn load-bytes
  "Reads and compiles a policy from raw bytes. Throws ex-info with :problems."
  [^bytes bs]
  (when (> (alength bs) max-bytes)
    (throw (ex-info "invalid policy" {:problems [(str "policy file is larger than " max-bytes " bytes")]})))
  (let [text (String. bs StandardCharsets/UTF_8)
        doc (try
              ;; No reader tags are enabled: EDN data only, no code.
              (edn/read-string {:readers {} :default (fn [tag _] (throw (ex-info (str "unknown tag " tag) {})))} text)
              (catch Exception e
                (throw (ex-info "invalid policy" {:problems [(str "not readable EDN: " (.getMessage e))]}))))]
    (compile-policy doc bs)))

(defn load-file* [path]
  (load-bytes (java.nio.file.Files/readAllBytes (.toPath (java.io.File. ^String path)))))

(defn load-string* [^String s]
  (load-bytes (.getBytes s StandardCharsets/UTF_8)))
