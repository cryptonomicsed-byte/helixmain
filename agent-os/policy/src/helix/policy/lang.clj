(ns helix.policy.lang
  "The rule language.

  A policy is EDN data written by an operator and read from a file. A rule's
  condition is a small vector expression, `[:and [:= [:intent :risk] \"high\"] ...]`,
  interpreted here by a closed `case`. There is no `eval`, no `read-string`
  with reader macros enabled, no regex taken from a request, and no function
  lookup by name: the only things a condition can do are the operators below.

  Every operator is total. Asked about a missing path or a value of the wrong
  type it answers false, it never throws, so a hostile request cannot make
  evaluation fail in a way that differs from \"the condition did not hold\".
  (The evaluator also treats an exception as DENY, belt and braces.)"
  (:require [clojure.string :as str]))

(def roots
  "The request sections a condition may read. `format` is not one of them."
  #{"now" "organization_id" "principal" "agent" "intent" "confirmation"})

(def ^:private max-depth 12)
(def ^:private max-nodes 400)
(def ^:private max-pattern 256)

(defn- name* [x] (if (or (keyword? x) (symbol? x)) (name x) x))

(defn normalize-path
  "Policy authors write [:intent :risk]; requests are string-keyed, so keywords
  become strings once, at load time. Returns nil for a path that is not valid."
  [path]
  (when (and (vector? path) (seq path) (<= (count path) 8)
             (every? #(or (keyword? %) (string? %) (and (integer? %) (<= 0 % 1000))) path))
    (let [p (mapv name* path)]
      (when (contains? roots (first p)) p))))

(defn glob-match?
  "`*` matches any run of characters, `?` exactly one, everything else is
  literal. Two-pointer matching with a single backtrack point: no regex, so no
  pattern can blow up, and the cost is bounded by |pattern| x |text|."
  [^String pattern ^String text]
  (let [pn (count pattern) tn (count text)]
    (loop [pi 0 ti 0 star -1 mark 0]
      (cond
        (< ti tn)
        (cond
          (and (< pi pn) (or (= \? (.charAt pattern pi)) (= (.charAt pattern pi) (.charAt text ti))) (not= \* (.charAt pattern pi)))
          (recur (inc pi) (inc ti) star mark)
          (and (< pi pn) (= \* (.charAt pattern pi)))
          (recur (inc pi) ti pi ti)
          (>= star 0)
          (recur (inc star) (inc mark) star (inc mark))
          :else false)
        :else
        (loop [pi pi]
          (cond (>= pi pn) true
                (= \* (.charAt pattern pi)) (recur (inc pi))
                :else false))))))

(defn lookup [req path]
  (reduce (fn [v k]
            (cond
              (map? v) (get v k)
              (and (sequential? v) (integer? k)) (nth v k nil)
              :else (reduced nil)))
          req path))

(defn- num? [v] (and (number? v) (not (Double/isNaN (double v)))))

(def ops
  "operator -> [arity-check]. Arity here is the number of arguments after the
  operator keyword."
  {:always 0 :and :n :or :n :not 1
   := 2 :not= 2 :in 2 :contains 2
   :> 2 :>= 2 :< 2 :<= 2
   :present 1 :starts-with 2 :glob 2 :one-of-glob 2})

(defn validate-cond
  "Returns a vector of problems for a condition expression, [] when it is
  well-formed. Paths are normalised by `compile-cond`, not here."
  ([c] (validate-cond c 0 (volatile! 0)))
  ([c depth nodes]
   (vswap! nodes inc)
   (cond
     (> @nodes max-nodes) ["condition is too large"]
     (> depth max-depth) ["condition is nested too deeply"]
     (not (and (vector? c) (keyword? (first c)))) [(str "condition must be a vector starting with an operator: " (pr-str c))]
     :else
     (let [op (first c) args (rest c) arity (get ops op)]
       (cond
         (nil? arity) [(str "unknown operator " op)]
         (and (integer? arity) (not= arity (count args))) [(str op " takes " arity " argument(s)")]
         (and (= :n arity) (empty? args)) [(str op " needs at least one condition")]
         :else
         (case op
           (:and :or) (vec (mapcat #(validate-cond % (inc depth) nodes) args))
           :not (validate-cond (first args) (inc depth) nodes)
           :always []
           (:= :not=) (cond-> []
                        (nil? (normalize-path (first args))) (conj (str op ": bad path " (pr-str (first args))))
                        (not (or (string? (second args)) (integer? (second args)) (boolean? (second args))))
                        (conj (str op ": the value must be a string, integer or boolean")))
           (:in :one-of-glob) (cond-> []
                                (nil? (normalize-path (first args))) (conj (str op ": bad path " (pr-str (first args))))
                                (not (and (vector? (second args)) (seq (second args)) (<= (count (second args)) 256)
                                          (every? (if (= op :in) #(or (string? %) (integer? %)) #(and (string? %) (<= (count %) max-pattern))) (second args))))
                                (conj (str op ": the second argument must be a non-empty vector of " (if (= op :in) "strings or integers" "patterns"))))
           :contains (cond-> []
                       (nil? (normalize-path (first args))) (conj (str op ": bad path " (pr-str (first args))))
                       (not (string? (second args))) (conj ":contains: the value must be a string"))
           (:> :>= :< :<=) (cond-> []
                             (nil? (normalize-path (first args))) (conj (str op ": bad path " (pr-str (first args))))
                             (not (integer? (second args))) (conj (str op ": the limit must be an integer")))
           :present (if (nil? (normalize-path (first args))) [(str op ": bad path " (pr-str (first args)))] [])
           (:starts-with :glob) (cond-> []
                                  (nil? (normalize-path (first args))) (conj (str op ": bad path " (pr-str (first args))))
                                  (not (and (string? (second args)) (<= (count (second args)) max-pattern)))
                                  (conj (str op ": the pattern must be a string of at most " max-pattern " characters"))))))))
  )

(defn compile-cond
  "Turns a validated condition into a function of the request. The result is a
  closure over data, nothing else."
  [c]
  (let [op (first c) args (rest c)]
    (case op
      :always (constantly true)
      :and (let [fs (mapv compile-cond args)] (fn [r] (every? #(% r) fs)))
      :or (let [fs (mapv compile-cond args)] (fn [r] (boolean (some #(% r) fs))))
      :not (let [f (compile-cond (first args))] (fn [r] (not (f r))))
      := (let [p (normalize-path (first args)) v (second args)] (fn [r] (= v (lookup r p))))
      :not= (let [p (normalize-path (first args)) v (second args)] (fn [r] (not= v (lookup r p))))
      :in (let [p (normalize-path (first args)) s (set (second args))] (fn [r] (contains? s (lookup r p))))
      :contains (let [p (normalize-path (first args)) v (second args)]
                  (fn [r] (let [x (lookup r p)] (and (sequential? x) (boolean (some #(= v %) x))))))
      :> (let [p (normalize-path (first args)) n (second args)] (fn [r] (let [x (lookup r p)] (and (num? x) (> x n)))))
      :>= (let [p (normalize-path (first args)) n (second args)] (fn [r] (let [x (lookup r p)] (and (num? x) (>= x n)))))
      :< (let [p (normalize-path (first args)) n (second args)] (fn [r] (let [x (lookup r p)] (and (num? x) (< x n)))))
      :<= (let [p (normalize-path (first args)) n (second args)] (fn [r] (let [x (lookup r p)] (and (num? x) (<= x n)))))
      :present (let [p (normalize-path (first args))]
                 (fn [r] (let [x (lookup r p)] (and (some? x) (not= "" x) (not= [] x) (not= {} x)))))
      :starts-with (let [p (normalize-path (first args)) s (second args)]
                     (fn [r] (let [x (lookup r p)] (and (string? x) (str/starts-with? x s)))))
      :glob (let [p (normalize-path (first args)) pat (second args)]
              (fn [r] (let [x (lookup r p)] (and (string? x) (glob-match? pat x)))))
      :one-of-glob (let [p (normalize-path (first args)) pats (second args)]
                     (fn [r] (let [x (lookup r p)] (and (string? x) (boolean (some #(glob-match? % x) pats)))))))))
