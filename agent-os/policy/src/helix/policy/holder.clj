(ns helix.policy.holder
  "Keeps the live policy and follows the file on disk.

  If the file changes and the new version is valid it takes effect; the next
  decision carries the new policy_version. If the file changes and the new
  version is NOT valid the service does not keep running the old, possibly
  more permissive, rules: it answers DENY for everything until the file is
  fixed and reports itself unhealthy. A typo in a tightening change must never
  leave the previous, looser policy in force."
  (:require [clojure.string :as str]
            [helix.policy.rules :as rules])
  (:import (java.io File)))

(defn- read-state [^String path]
  (let [f (File. path)]
    (try
      {:path path :mtime (.lastModified f) :size (.length f)
       :policy (rules/load-file* path) :error nil}
      (catch clojure.lang.ExceptionInfo e
        {:path path :mtime (.lastModified f) :size (.length f) :policy nil
         :error (str/join "; " (:problems (ex-data e) [(.getMessage e)]))})
      (catch Exception e
        {:path path :mtime (.lastModified f) :size (.length f) :policy nil
         :error (str "cannot read policy: " (.getMessage e))}))))

(defn open
  "Loads the policy at `path`. Never throws: a bad file is a state, reported by
  `current`. `check-interval-ms` bounds how often the file is stat'ed."
  ([path] (open path 1000))
  ([path check-interval-ms]
   {:state (atom (assoc (read-state path) :checked (System/currentTimeMillis)))
    :interval check-interval-ms}))

(defn current
  "The live state: {:policy .. :error ..}, refreshed from disk when the file's
  modification time or size changed since the last look."
  [{:keys [state interval]}]
  (let [{:keys [path mtime size checked]} @state
        now (System/currentTimeMillis)]
    (when (>= (- now checked) interval)
      (let [f (File. ^String path)]
        (if (or (not= mtime (.lastModified f)) (not= size (.length f)))
          (reset! state (assoc (read-state path) :checked now))
          (swap! state assoc :checked now))))
    @state))
